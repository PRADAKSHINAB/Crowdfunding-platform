const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const morgan = require('morgan');
const multer = require('multer');
const formidable = require('formidable');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Security middleware & helpers
const security = require('./security');

// Import services
const tokenService = require('./services/tokenService');
const auditService = require('./services/auditService');
const analyticsService = require('./services/analyticsService');
const emailService = require('./services/emailService');

// Import Models
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const KYC = require('../models/KYC');
const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const AuditLog = require('../models/AuditLog');

// Import MongoDB connection and utilities
const { connectMongoDB, mongoDb, migrateData } = require('./mongodb');

const app = express();
app.use(cookieParser());

// Connect to MongoDB
let useMongoDb = false;
connectMongoDB().then(connected => {
  useMongoDb = connected;
  if (connected) {
    console.log('Using MongoDB for data storage');
    // Migrate existing data to MongoDB
    migrateData();
  } else {
    console.log('Using file system for data storage');
  }
});

// Admin: List users (Mongo-first, fallback to file). Returns safe fields only.
app.get('/api/admin/users', security.requireAdminAuth, async (req, res) => {
    try {
        if (useMongoDb) {
            try {
                const list = await mongoDb.getUsers();
                const mapped = (list || []).map(u => {
                    const o = u.toObject ? u.toObject() : u;
                    return {
                        id: (o._id || '').toString(),
                        username: o.username || '',
                        email: o.email || '',
                        fullName: o.fullName || `${o.firstName || ''} ${o.lastName || ''}`.trim(),
                        isKYCVerified: !!o.isKYCVerified,
                        createdAt: o.createdAt || null
                    };
                });
                return res.json(mapped);
            } catch (e) {
                console.log('Mongo getUsers failed:', e.message);
            }
        }
        const usersFile = readJson('users.json', []);
        const mapped = (usersFile || []).map(u => ({
            id: u.id,
            username: u.username || (u.email ? u.email.split('@')[0] : ''),
            email: u.email || '',
            fullName: u.fullName || `${u.firstName || ''} ${u.lastName || ''}`.trim(),
            isKYCVerified: !!u.isKYCVerified,
            createdAt: u.createdAt || null
        }));
        return res.json(mapped);
    } catch (error) {
        console.error('Users list error:', error);
        res.status(500).json({ message: 'Failed to get users' });
    }
});

// Admin: deduplicate KYC records
// Rules:
// - Primary group key: campaignId when present (stringified)
// - Fallback group key: `${userId}:${aadhaarNumber}` when campaignId is empty
// - Keep priority: verified > pending > rejected. If same status, keep newest createdAt
app.delete('/api/admin/kyc/deduplicate', security.requireAdminAuth, async (req, res) => {
    try {
        let deletedMongo = 0;
        let deletedFile = 0;

        // Helper: determine priority rank by status
        const statusRank = (s) => {
            const v = String(s || '').toLowerCase();
            if (v === 'verified' || v === 'approved') return 3;
            if (v === 'pending') return 2;
            if (v === 'rejected') return 1;
            return 0;
        };

        // Helper: choose keep vs dup by rank then createdAt
        const better = (a, b) => {
            const ra = statusRank(a.status);
            const rb = statusRank(b.status);
            if (ra !== rb) return ra > rb ? a : b;
            const ta = new Date(a.createdAt || 0).getTime();
            const tb = new Date(b.createdAt || 0).getTime();
            return ta >= tb ? a : b;
        };

        // Helper: compute delete IDs with grouping & priority
        const computeIdsToDelete = (list) => {
            const groups = new Map();
            for (const k of list || []) {
                const cid = String(k.campaignId ?? '').trim();
                const fallbackKey = `${String(k.userId || '').trim()}:${String(k.aadhaarNumber || '').trim()}`;
                const key = cid || fallbackKey;
                if (!groups.has(key)) {
                    groups.set(key, { keep: k, dups: [] });
                } else {
                    const g = groups.get(key);
                    const winner = better(g.keep, k);
                    const loser = winner === g.keep ? k : g.keep;
                    g.keep = winner;
                    g.dups.push(loser);
                }
            }
            const ids = [];
            for (const [, g] of groups) {
                for (const d of g.dups) ids.push(d.id || d._id?.toString());
            }
            return ids.filter(Boolean);
        };

        // Mongo path
        if (useMongoDb) {
            try {
                const mongoList = await mongoDb.getKYCs();
                const normalized = (mongoList || []).map(m => ({
                    id: (m._id || '').toString(),
                    campaignId: (m.campaignId ?? ''),
                    userId: (m.userId ?? ''),
                    aadhaarNumber: (m.aadhaarNumber ?? ''),
                    status: m.status,
                    createdAt: m.createdAt
                }));

                const idsToDelete = computeIdsToDelete(normalized);
                if (idsToDelete.length) {
                    const result = await mongoDb.deleteKYCsByIds(idsToDelete);
                    deletedMongo = result.deletedCount || 0;
                }
            } catch (e) {
                console.log('Mongo KYC dedupe failed:', e.message);
            }
        }

        // File path (and also clean mirror)
        try {
            const fileList = readJson('kyc.json', []);
            const idsToDeleteFile = computeIdsToDelete(fileList);

            if (idsToDeleteFile.length) {
                const remaining = fileList.filter(k => !idsToDeleteFile.includes(String(k.id)));
                deletedFile = fileList.length - remaining.length;
                writeJson('kyc.json', remaining);
            }
        } catch (e) {
            console.log('File KYC dedupe failed:', e.message);
        }

        return res.json({ success: true, deletedMongo, deletedFile });
    } catch (e) {
        console.error('Error deduplicating KYC:', e);
        res.status(500).json({ message: 'Failed to deduplicate KYC' });
    }
});

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Initialize Razorpay
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
} else {
    console.warn('Razorpay keys are not configured. Payment endpoints will be disabled.');
}

// ─── Security headers (Helmet) ───────────────────────────────────────────────
app.use(helmet(security.helmetOptions()));
app.use(helmet.referrerPolicy({ policy: 'strict-origin-when-cross-origin' }));
app.use(helmet.noSniff());
app.use(helmet.xssFilter());
app.use(helmet.hidePoweredBy());
app.disable('x-powered-by');

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (CLIENT_ORIGIN === '*')
    ? true
    : CLIENT_ORIGIN.split(',').map(s => s.trim());
app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// ─── Body parsers with size limits ────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── HTTP request logging (production-safe: no 'dev' verbose) ─────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Global rate limiter ──────────────────────────────────────────────────────
app.use('/api/', security.generalLimiter);

// JWT helpers
function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

const requireAuth = [security.requireAuth, security.checkAccountStatus];

// Storage paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', 'crowdfunding');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Simple JSON store utilities
function readJson(fileName, fallback) {
    const filePath = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(filePath)) return fallback;
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content || 'null') ?? fallback;
    } catch (err) {
        console.error('Failed to read', fileName, err);
        return fallback;
    }
}

function writeJson(fileName, data) {
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Multer setup for basic file uploads (images/docs)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname) || '';
        cb(null, unique + ext);
    }
});
const upload = multer({ storage });

// Seed defaults if not present
function ensureSeeds() {
    const campaigns = readJson('campaigns.json', null);
    if (!campaigns) {
        writeJson('campaigns.json', [
            {
                id: 1,
                title: 'Eco-Friendly Community Garden',
                description: 'Creating a sustainable green space for urban farming and education.',
                image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=400&fit=crop',
                goal: 1660000, // 20,000 * 83
                raised: 1245000, // 15,000 * 83
                backers: 234,
                daysLeft: 12,
                badge: 'Trending',
                status: 'approved',
                createdAt: new Date().toISOString()
            },
            {
                id: 2,
                title: 'Portable Solar Power Bank',
                description: 'Revolutionary solar-powered charging solution for outdoor enthusiasts.',
                image: 'https://images.unsplash.com/photo-1497435334941-8c899ee9e8e9?w=800&h=400&fit=crop',
                goal: 8300000, // 100,000 * 83
                raised: 3735000, // 45,000 * 83
                backers: 567,
                daysLeft: 28,
                badge: 'New',
                status: 'approved',
                createdAt: new Date().toISOString()
            },
            {
                id: 3,
                title: 'Smart Home Garden System',
                description: 'AI-powered indoor garden that grows fresh herbs and vegetables automatically.',
                image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=400&fit=crop',
                goal: 16600000, // 200,000 * 83
                raised: 14940000, // 180,000 * 83
                backers: 1234,
                daysLeft: 5,
                badge: 'Popular',
                status: 'approved',
                createdAt: new Date().toISOString()
            }
        ]);
    }

    const donations = readJson('donations.json', null);
    if (!donations) writeJson('donations.json', []);

    const users = readJson('users.json', null);
    if (!users) writeJson('users.json', []);

    const admins = readJson('admins.json', null);
    if (!admins) {
        // IMPORTANT: Default admin credentials are intentionally weak for dev only.
        // On first run, change via /api/admin/change-password or set env vars.
        const defaultAdminPass = process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2024!';
        const defaultAdminCode = process.env.ADMIN_INVITE_CODE || 'GREENFUND2024';
        const hashedPass = bcrypt.hashSync(defaultAdminPass, 12);
        writeJson('admins.json', [{ username: 'admin', password: hashedPass, code: defaultAdminCode }]);
        console.log('[SECURITY] Default admin created. Change password immediately!');
    }

    const settings = readJson('settings.json', null);
    if (!settings) writeJson('settings.json', { autoApprovalThreshold: 5000, reviewTime: 48 });
}

ensureSeeds();

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Campaigns
// Campaigns - upgraded with geospatial near, city/state/country filters, and sorting verified campaigns higher
app.get('/api/campaigns', async (req, res) => {
    const { status, lat, lng, distance, city, state, country, category, search } = req.query;
    const targetStatus = status || 'approved'; // defaults to approved for public
    
    try {
        if (useMongoDb) {
            // Geospatial MongoDB query
            if (lat && lng) {
                const latitude = parseFloat(lat);
                const longitude = parseFloat(lng);
                
                if (isNaN(latitude) || isNaN(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
                    return res.status(400).json({ message: 'Invalid latitude or longitude coordinates' });
                }
                
                // Aggregation pipeline to use $geoNear and also sort by verified status
                const matchQuery = { status: targetStatus };
                if (city) matchQuery.city = new RegExp(city, 'i');
                if (state) matchQuery.state = new RegExp(state, 'i');
                if (country) matchQuery.country = new RegExp(country, 'i');
                if (category) matchQuery.category = category;
                if (search) {
                    matchQuery.$or = [
                        { title: new RegExp(search, 'i') },
                        { description: new RegExp(search, 'i') }
                    ];
                }
                
                const pipeline = [
                    {
                        $geoNear: {
                            near: { type: 'Point', coordinates: [longitude, latitude] },
                            distanceField: 'distance',
                            maxDistance: parseInt(distance, 10) || 1000000, // default max 1000km
                            query: matchQuery,
                            spherical: true
                        }
                    },
                    {
                        $sort: { isVerified: -1, distance: 1 } // verified first, then closest
                    }
                ];
                
                const list = await Campaign.aggregate(pipeline);
                
                // Map _id to id for client compatibility
                const results = list.map(item => ({
                    ...item,
                    id: item._id.toString()
                }));
                
                return res.json(results);
            } else {
                // Non-geospatial MongoDB query
                const query = { status: targetStatus };
                if (city) query.city = new RegExp(city, 'i');
                if (state) query.state = new RegExp(state, 'i');
                if (country) query.country = new RegExp(country, 'i');
                if (category) query.category = category;
                if (search) {
                    query.$or = [
                        { title: new RegExp(search, 'i') },
                        { description: new RegExp(search, 'i') }
                    ];
                }
                
                // Sort verified campaigns higher, then newest
                const list = await Campaign.find(query).sort({ isVerified: -1, createdAt: -1 });
                const results = list.map(item => {
                    const obj = item.toObject();
                    obj.id = obj._id.toString();
                    return obj;
                });
                return res.json(results);
            }
        }
    } catch (e) {
        console.error('Geo campaign search error:', e.message);
    }
    
    // File fallback
    const campaigns = readJson('campaigns.json', []);
    let filtered = campaigns;
    
    // Always filter by status
    filtered = filtered.filter(c => c.status === targetStatus);
    
    if (city) filtered = filtered.filter(c => String(c.city || '').toLowerCase().includes(city.toLowerCase()));
    if (state) filtered = filtered.filter(c => String(c.state || '').toLowerCase().includes(state.toLowerCase()));
    if (country) filtered = filtered.filter(c => String(c.country || '').toLowerCase().includes(country.toLowerCase()));
    if (category) filtered = filtered.filter(c => c.category === category);
    if (search) {
        const queryStr = search.toLowerCase();
        filtered = filtered.filter(c => 
            (c.title || '').toLowerCase().includes(queryStr) || 
            (c.description || '').toLowerCase().includes(queryStr)
        );
    }
    
    // Sort verified first, then by date (file fallback has no geoNear sorting)
    filtered.sort((a, b) => {
        const vA = a.isVerified ? 1 : 0;
        const vB = b.isVerified ? 1 : 0;
        if (vB !== vA) return vB - vA;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    
    res.json(filtered);
});

// Public: Get KYC status for a user
app.get('/api/kyc/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    try {
        if (useMongoDb) {
            const record = await mongoDb.getKYCByUserId(userId);
            if (!record) {
                // Fallback: user flag
                const user = await mongoDb.getUserById(userId).catch(() => null);
                if (user && user.isKYCVerified === true) {
                    return res.json({ status: 'verified' });
                }
                // Fallback: try to match by fullName
                if (user && user.fullName) {
                    try {
                        const all = await mongoDb.getKYCs();
                        const match = (all || []).find(k => String(k.fullName || '').toLowerCase() === String(user.fullName).toLowerCase() && (k.status || '').toLowerCase() === 'verified');
                        if (match) {
                            return res.json({ status: 'verified', id: match._id, campaignId: match.campaignId });
                        }
                    } catch (_) {}
                }
                return res.json({ status: 'none' });
            }
            const s = (record.status || 'pending').toLowerCase();
            const mapped = s === 'approved' ? 'verified' : s;
            return res.json({ status: mapped, id: record._id, campaignId: record.campaignId });
        }

        const list = readJson('kyc.json', []);
        const items = list.filter(k => String(k.userId || '') === String(userId));
        if (!items.length) {
            const users = readJson('users.json', []);
            const u = users.find(x => String(x.id) === String(userId));
            if (u && u.isKYCVerified === true) {
                return res.json({ status: 'verified' });
            }
            // Fallback: try to match by fullName (firstName + lastName)
            const fullName = ((u?.fullName) || `${u?.firstName || ''} ${u?.lastName || ''}`.trim()) || '';
            if (fullName) {
                const byName = (list || []).find(k => String(k.fullName || '').toLowerCase() === fullName.toLowerCase() && (k.status || '').toLowerCase() === 'verified');
                if (byName) {
                    return res.json({ status: 'verified', id: byName.id, campaignId: byName.campaignId });
                }
            }
            return res.json({ status: 'none' });
        }
        const latest = items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
        const s = (latest.status || 'pending').toLowerCase();
        const mapped = s === 'approved' ? 'verified' : s;
        return res.json({ status: mapped, id: latest.id, campaignId: latest.campaignId });
    } catch (e) {
        console.error('Error getting KYC status:', e);
        res.status(500).json({ message: 'Failed to get KYC status' });
    }
});

// Admin: Get all campaigns (including pending/rejected)
app.get('/api/admin/campaigns', security.requireAdminAuth, (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    // Return all campaigns so admin can view every launch (pending/approved/rejected)
    res.json(campaigns);
});

// Admin: Update campaign status (approve/reject)
app.put('/api/admin/campaigns/:id/status', security.requireAdminAuth, (req, res) => {
    const { status, reason } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be approved or rejected' });
    }
    
    const campaigns = readJson('campaigns.json', []);
    const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    
    campaign.status = status;
    campaign.reviewedAt = new Date().toISOString();
    if (reason) campaign.rejectionReason = reason;
    
    writeJson('campaigns.json', campaigns);
    res.json({ success: true, campaign });
});

// Admin: Get pending campaigns count
app.get('/api/admin/pending-count', security.requireAdminAuth, (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    try {
        // Simple rule: show count of all campaigns with status 'pending'
        const pendingCount = (campaigns || []).filter(c => c.status === 'pending').length;
        res.json({ pendingCount });
    } catch (_) {
        // On any error, fall back to zero to avoid misleading counts
        res.json({ pendingCount: 0 });
    }
});

// Get total users count
app.get('/api/admin/users-count', security.requireAdminAuth, async (req, res) => {
    try {
        const users = await mongoDb.getUsers();
        return res.json({ totalUsers: Array.isArray(users) ? users.length : 0 });
    } catch (e) {
        console.log('Mongo getUsers failed:', e.message);
    }
    const usersFile = readJson('users.json', []);
    return res.json({ totalUsers: (usersFile || []).length });
});

// Admin: Get platform analytics
app.get('/api/admin/analytics', security.requireAdminAuth, async (req, res) => {
    try {
        if (!useMongoDb) {
            return res.status(503).json({ message: 'Analytics requires MongoDB' });
        }
        const stats = await analyticsService.getPlatformStats();
        const campaignStats = await analyticsService.getCampaignAnalytics();
        const userGrowth = await analyticsService.getUserGrowth(30);
        const loginActivity = await analyticsService.getLoginActivity(7);
        
        res.json({
            stats,
            campaignStats,
            userGrowth,
            loginActivity
        });
    } catch (error) {
        console.error('Analytics fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch analytics' });
    }
});

// Admin: Get event audit logs
app.get('/api/admin/audit-logs', security.requireAdminAuth, async (req, res) => {
    try {
        if (!useMongoDb) {
            return res.status(503).json({ message: 'Audit logs require MongoDB' });
        }
        const { page, limit, event, severity, userId, outcome } = req.query;
        const logsData = await analyticsService.getAuditLogs({
            page: parseInt(page, 10) || 1,
            limit: parseInt(limit, 10) || 50,
            event,
            severity,
            userId,
            outcome
        });
        res.json(logsData);
    } catch (error) {
        console.error('Audit logs fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch audit logs' });
    }
});

// Admin: Get security event feed
app.get('/api/admin/security/feed', security.requireAdminAuth, async (req, res) => {
    try {
        if (!useMongoDb) {
            return res.status(503).json({ message: 'Security feed requires MongoDB' });
        }
        const feed = await analyticsService.getSecurityFeed(50);
        res.json(feed);
    } catch (error) {
        console.error('Security feed fetch error:', error);
        res.status(500).json({ message: 'Failed to fetch security feed' });
    }
});

// Admin: Get suspicious IPs (failed logins)
app.get('/api/admin/security/suspicious', security.requireAdminAuth, async (req, res) => {
    try {
        if (!useMongoDb) {
            return res.status(503).json({ message: 'Suspicious activity analysis requires MongoDB' });
        }
        const ips = await analyticsService.getSuspiciousIPs(24, 5); // threshold 5 attempts
        res.json(ips);
    } catch (error) {
        console.error('Suspicious IPs fetch error:', error);
        res.status(500).json({ message: 'Failed to analyze login activity' });
    }
});

// Admin: Update user status (active/locked/suspended)
app.post('/api/admin/users/:id/status', security.requireAdminAuth, async (req, res) => {
    const { status, reason } = req.body || {};
    if (!['active', 'locked', 'suspended'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be active, locked, or suspended' });
    }

    try {
        if (useMongoDb) {
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ message: 'User not found' });

            user.status = status;
            if (status === 'locked') {
                user.lockUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // lock 24h
            } else {
                user.lockUntil = undefined;
                user.loginAttempts = 0;
            }
            await user.save();

            // If locking/suspending, revoke all user's sessions immediately
            if (status !== 'active') {
                await tokenService.revokeAllUserTokens(user._id.toString(), 'admin');
            }

            auditService.raw({
                event: 'admin.settings_change',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'user', id: user._id.toString() },
                metadata: { status, reason },
                severity: 'warning'
            });

            return res.json({ success: true, message: `User status updated to ${status}` });
        }
        
        // File-based fallback
        const users = readJson('users.json', []);
        const user = users.find(u => String(u.id) === String(req.params.id));
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.status = status;
        writeJson('users.json', users);
        return res.json({ success: true, message: `User status updated to ${status}` });
    } catch (error) {
        console.error('Update user status error:', error);
        res.status(500).json({ message: 'Failed to update user status' });
    }
});

// Admin: Get active sessions for a user
app.get('/api/admin/sessions/:userId', security.requireAdminAuth, async (req, res) => {
    try {
        if (!useMongoDb) {
            return res.status(503).json({ message: 'Sessions require MongoDB' });
        }
        const sessions = await tokenService.getActiveUserSessions(req.params.userId);
        res.json(sessions);
    } catch (error) {
        console.error('Get active sessions error:', error);
        res.status(500).json({ message: 'Failed to retrieve user sessions' });
    }
});

// Admin: Revoke specific session family
app.post('/api/admin/sessions/revoke', security.requireAdminAuth, async (req, res) => {
    const { family } = req.body || {};
    if (!family) return res.status(400).json({ message: 'Family identifier is required' });

    try {
        if (useMongoDb) {
            await tokenService.revokeFamilyTokens(family, 'admin');
            
            auditService.raw({
                event: 'admin.settings_change',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'session', id: family },
                metadata: { action: 'revoke_session' },
                severity: 'warning'
            });

            return res.json({ success: true, message: 'Session successfully revoked' });
        }
        return res.status(503).json({ message: 'MongoDB required for session revocation' });
    } catch (error) {
        console.error('Revoke session error:', error);
        res.status(500).json({ message: 'Failed to revoke session' });
    }
});

app.get('/api/campaigns/:id', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    res.json(campaign);
});

// Statistics endpoint
app.get('/api/statistics', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    // Only count approved campaigns for public statistics
    const approvedCampaigns = campaigns.filter(c => c.status === 'approved');

    const totalRaised = approvedCampaigns.reduce((sum, c) => sum + (c.raised || 0), 0);
    const totalCampaigns = approvedCampaigns.length;
    const totalBackers = approvedCampaigns.reduce((sum, c) => sum + (c.backers || 0), 0);

    // Calculate success rate (campaigns that reached at least 80% of goal)
    const successfulCampaigns = approvedCampaigns.filter(c => (c.raised / c.goal) >= 0.8).length;
    const successRate = totalCampaigns > 0 ? Math.round((successfulCampaigns / totalCampaigns) * 100) : 0;

    res.json({
        totalRaised: Math.round(totalRaised),
        totalCampaigns,
        totalBackers,
        successRate
    });
});

app.post('/api/campaigns/:id/create-order', requireAuth, security.paymentLimiter, security.validateCampaignId, security.handleValidationErrors, async (req, res) => {
    try {
        if (!razorpay) {
            return res.status(503).json({ message: 'Payment gateway is not configured' });
        }
        const { amount, donorName, donorEmail } = req.body || {};
        const amt = parseInt(amount, 10);      
        if (!amt || amt <= 0) {
            return res.status(400).json({ message: 'Invalid amount' });
        }     
        const campaigns = readJson('campaigns.json', []);
        const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }
        // Create Razorpay order
        // Construct a compact receipt to comply with Razorpay's 40-char limit
        const receiptBase = `rcpt_${String(campaign.id).slice(-10)}_${Date.now().toString().slice(-8)}`;
        const safeReceipt = receiptBase.slice(0, 40);
        const options = {
            amount: amt * 100, // Convert to paise (₹1 = 100 paise)
            currency: 'INR',
            receipt: safeReceipt,
            notes: {
                campaignId: campaign.id,
                campaignTitle: campaign.title,
                donorName: donorName || 'Anonymous',
                donorEmail: donorEmail || ''
            }
        };

        const order = await razorpay.orders.create(options);
        
        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            campaignTitle: campaign.title
        });
    } catch (error) {
        console.error('Error creating Razorpay order:', error);
        res.status(500).json({ message: 'Failed to create payment order', error: error.message });
    }
});

// Fraud detection helper
async function runFraudCheck(donationData) {
    const result = { score: 0, reasons: [] };
    
    // Check 1: High single amount (> 50,000 INR)
    if (donationData.amount > 50000) {
        result.score += 30;
        result.reasons.push('High donation amount (> 50,000 INR)');
    }
    
    // Check 2: High frequency (more than 3 donations from same email in 1 hour)
    if (useMongoDb && donationData.donorEmail) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        try {
            const count = await Donation.countDocuments({
                donorEmail: donationData.donorEmail,
                createdAt: { $gte: oneHourAgo }
            });
            if (count >= 3) {
                result.score += 40;
                result.reasons.push('High frequency donation (>= 3 attempts in 1 hour)');
            }
        } catch (_) {}
    }
    
    // Check 3: Check for suspicious/disposable email domains
    const suspiciousDomains = ['tempmail.com', 'throwaway.com', 'mailinator.com', 'yopmail.com'];
    const emailDomain = (donationData.donorEmail || '').split('@')[1];
    if (emailDomain && suspiciousDomains.includes(emailDomain.toLowerCase())) {
        result.score += 50;
        result.reasons.push('Suspicious disposable email domain');
    }
    
    return {
        flagged: result.score >= 40,
        result
    };
}

// Verify Payment and Save Donation (Step 2: After payment success)
app.post('/api/campaigns/:id/verify-payment', requireAuth, security.paymentLimiter, async (req, res) => {
    try {
        if (!razorpay) {
            return res.status(503).json({ message: 'Payment gateway is not configured' });
        }
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, donorName, donorEmail } = req.body || {};
        
        // Verify signature to ensure payment is genuine
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(sign.toString())
            .digest('hex');

        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ message: 'Invalid payment signature' });
        }

        // Fetch payment details from Razorpay to get authoritative amount/status
        let paymentInfo = null;
        try {
            paymentInfo = await razorpay.payments.fetch(razorpay_payment_id);
        } catch (e) {
            console.log('Razorpay payment fetch failed:', e.message);
        }

        // Determine amount in rupees and status
        const paidPaise = paymentInfo?.amount || Number(amount) || 0; // prefer gateway value
        const paidRupees = Math.round(paidPaise / 100);

        // Payment is verified - now save the donation
        const campaigns = readJson('campaigns.json', []);
        const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        let donation;
        if (useMongoDb) {
            // Run fraud detection check
            const fraudCheck = await runFraudCheck({ amount: paidRupees, donorEmail: donorEmail || '' });
            
            donation = new Donation({
                campaignId: campaign._id || campaign.id,
                amount: paidRupees,
                donorName: donorName || 'Anonymous',
                donorEmail: donorEmail || '',
                donorId: req.user?.id,
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
                razorpaySignature: razorpay_signature,
                status: 'held', // Marked as held in escrow!
                fraudFlagged: fraudCheck.flagged,
                fraudCheckResult: fraudCheck.result
            });
            
            donation.statusTimeline.push({
                status: 'held',
                updatedBy: 'system',
                note: fraudCheck.flagged ? `Held in escrow. Fraud flagged: ${fraudCheck.result.reasons.join(', ')}` : 'Captured and held in escrow.'
            });
            
            await donation.save();
            
            // Increment campaign stats (both escrow/raised)
            const mongoCampaign = await Campaign.findById(campaign._id || campaign.id);
            if (mongoCampaign) {
                mongoCampaign.raised += paidRupees;
                mongoCampaign.backers += 1;
                await mongoCampaign.save();
                
                // Mirror the updated stats to campaigns.json so everything is in sync
                const campaignsFile = readJson('campaigns.json', []);
                const match = campaignsFile.find(c => String(c.id) === String(campaign.id));
                if (match) {
                    match.raised = mongoCampaign.raised;
                    match.backers = mongoCampaign.backers;
                    writeJson('campaigns.json', campaignsFile);
                }
                
                // Trigger real-time notifications via socket!
                const io = req.app.get('io');
                if (io) {
                    // Update campaign room stats
                    io.to(`campaign_${campaign.id}`).emit('campaign_update', {
                        raised: mongoCampaign.raised,
                        backers: mongoCampaign.backers
                    });
                    
                    // Notify campaign creator
                    io.to(mongoCampaign.creatorId.toString()).emit('notification', {
                        type: 'donation_received',
                        message: `New donation of ₹${paidRupees} received for your campaign "${mongoCampaign.title}".`,
                        campaignId: campaign.id
                    });
                    
                    // Check if campaign goal achieved
                    if (mongoCampaign.raised >= mongoCampaign.goal) {
                        io.to(mongoCampaign.creatorId.toString()).emit('notification', {
                            type: 'goal_achieved',
                            message: `Congratulations! Your campaign "${mongoCampaign.title}" has achieved its funding goal of ₹${mongoCampaign.goal}!`,
                            campaignId: campaign.id
                        });
                    }
                }
            }
        } else {
            // File fallback - save to donations.json with status 'held'
            const donationsFile = readJson('donations.json', []);
            donation = {
                id: donationsFile.length ? Math.max(...donationsFile.map(d => Number(d.id) || 0)) + 1 : 1,
                campaignId: campaign.id,
                amount: paidRupees,
                donorName: donorName || 'Anonymous',
                donorEmail: donorEmail || '',
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
                status: 'held',
                createdAt: new Date().toISOString()
            };
            donationsFile.push(donation);
            writeJson('donations.json', donationsFile);
            
            // Increment file campaign stats
            const campaignsFile = readJson('campaigns.json', []);
            const match = campaignsFile.find(c => String(c.id) === String(campaign.id));
            if (match) {
                match.raised += paidRupees;
                match.backers += 1;
                writeJson('campaigns.json', campaignsFile);
            }
        }

        res.json({ 
            success: true, 
            message: 'Payment verified and donation recorded in escrow hold',
            donation, 
            campaign 
        });
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ message: 'Payment verification failed', error: error.message });
    }
});

// OLD Donation endpoint (kept for backward compatibility, but should not be used)
app.post('/api/campaigns/:id/donations', (req, res) => {
    res.status(400).json({ 
        message: 'Direct donations are disabled. Please use Razorpay payment flow.',
        hint: 'Use /api/campaigns/:id/create-order to initiate payment'
    });
});

// Auth: User Registration
app.post('/api/auth/register', security.authLimiter, security.validateRegister, security.handleValidationErrors, async (req, res) => {
    const { firstName, lastName, email, phone, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    
    try {
        const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        if (useMongoDb) {
            const existingUser = await mongoDb.getUserByEmail(email);
            if (existingUser) {
                return res.status(409).json({ message: 'Email already registered' });
            }
            
            const user = await mongoDb.createUser({
                username: email.split('@')[0],
                firstName: firstName || '',
                lastName: lastName || '',
                email,
                phone: phone || '',
                password,
                fullName: `${firstName || ''} ${lastName || ''}`.trim(),
                role: 'user',
                status: 'active',
                isEmailVerified: false,
                emailVerificationToken: verificationToken,
                emailVerificationExpires: verificationExpires,
                createdAt: new Date()
            });
            
            // Send verification email (non-blocking)
            emailService.sendVerificationEmail(user.email, verificationToken, origin)
                .catch(err => console.error('[EMAIL ERROR] Failed to send verification email:', err.message));

            const { token, jti } = tokenService.signAccessToken({ id: user._id.toString(), email: user.email, role: user.role });
            const refreshInfo = await tokenService.createRefreshToken(user._id.toString(), req);
            
            res.cookie('refreshToken', refreshInfo.token, tokenService.refreshCookieOptions(refreshInfo.expiresAt));
            
            auditService.userRegister(req, user);
            
            return res.status(201).json({ 
                id: user._id, 
                email: user.email, 
                token, 
                isEmailVerified: user.isEmailVerified,
                message: 'Registration successful. Verification email has been sent.'
            });
        } else {
            // Fallback to file system
            const users = readJson('users.json', []);
            if (users.find(u => u.email === email)) return res.status(409).json({ message: 'Email already registered' });
            const hashed = await bcrypt.hash(password, 10);
            const user = {
                id: users.length ? Math.max(...users.map(u => Number(u.id) || 0)) + 1 : 1,
                firstName: firstName || '',
                lastName: lastName || '',
                email,
                phone: phone || '',
                password: hashed,
                isEmailVerified: true, // Auto-verify on local file storage
                createdAt: new Date().toISOString()
            };
            users.push(user);
            writeJson('users.json', users);
            
            const { token } = tokenService.signAccessToken({ id: user.id, email: user.email, role: 'user' });
            return res.status(201).json({ id: user.id, email: user.email, token });
        }
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// Auth: Email Verification Triggered via Link
app.post('/api/auth/verify-email', async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ message: 'Verification token is required' });

    try {
        if (useMongoDb) {
            const user = await User.findOne({
                emailVerificationToken: token,
                emailVerificationExpires: { $gt: new Date() }
            });

            if (!user) {
                return res.status(400).json({ message: 'Verification token is invalid or has expired' });
            }

            user.isEmailVerified = true;
            user.emailVerificationToken = undefined;
            user.emailVerificationExpires = undefined;
            await user.save();

            // Log event
            auditService.raw({
                event: 'user.email_verify',
                actor: { userId: user._id.toString(), username: user.email, role: 'user' },
                resource: { type: 'user', id: user._id.toString() },
                outcome: 'success'
            });

            return res.json({ success: true, message: 'Account successfully verified!' });
        }
        return res.status(400).json({ message: 'MongoDB not enabled for email verification' });
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({ message: 'Internal server error during verification' });
    }
});

// Auth: Forgot Password (Request Link)
app.post('/api/auth/forgot-password', security.authLimiter, async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email is required' });

    try {
        if (useMongoDb) {
            const user = await User.findOne({ email });
            if (!user) {
                // To prevent email enumeration, return 200 OK anyway
                return res.json({ message: 'If that email exists in our system, a password reset link has been sent.' });
            }

            const resetToken = crypto.randomBytes(32).toString('hex');
            user.passwordResetToken = resetToken;
            user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            await user.save();

            const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
            emailService.sendPasswordResetEmail(user.email, resetToken, origin)
                .catch(err => console.error('[EMAIL ERROR] Failed to send password reset email:', err.message));

            auditService.passwordResetRequest(req, email);

            return res.json({ message: 'If that email exists in our system, a password reset link has been sent.' });
        }
        return res.status(400).json({ message: 'MongoDB not enabled for password reset' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Auth: Reset Password (Apply)
app.post('/api/auth/reset-password', security.authLimiter, async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ message: 'Token and new password are required' });

    try {
        if (useMongoDb) {
            const user = await User.findOne({
                passwordResetToken: token,
                passwordResetExpires: { $gt: new Date() }
            });

            if (!user) {
                return res.status(400).json({ message: 'Password reset token is invalid or has expired' });
            }

            // Password length/pattern check manually (same as validator)
            if (password.length < 8 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
                return res.status(400).json({ 
                    message: 'Password must be 8-128 characters and contain at least one uppercase letter, one lowercase letter, and one number' 
                });
            }

            // Setting new password triggers the User pre-save hook to hash
            user.password = password;
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            // Clear lockout just in case
            user.loginAttempts = 0;
            user.lockUntil = undefined;
            user.status = 'active';
            await user.save();

            // Revoke all existing sessions/refresh tokens for this user
            await tokenService.revokeAllUserTokens(user._id.toString(), 'password_change');

            auditService.passwordReset(req, user._id.toString());

            return res.json({ success: true, message: 'Password reset successful. Please log in with your new password.' });
        }
        return res.status(400).json({ message: 'MongoDB not enabled for password reset' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Auth: User Login
app.post('/api/auth/login', security.authLimiter, security.validateLogin, security.handleValidationErrors, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    try {
        if (useMongoDb) {
            const user = await mongoDb.getUserByEmail(email);
            if (!user) {
                auditService.userLoginFailed(req, email);
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Check if account is locked
            if (user.status === 'locked' && user.lockUntil && user.lockUntil > new Date()) {
                return res.status(403).json({ 
                    message: `Account temporarily locked due to too many failed attempts. Try again after ${user.lockUntil.toLocaleTimeString()}`
                });
            }

            let ok = false;
            if (typeof user.comparePassword === 'function') {
                ok = await user.comparePassword(password);
            } else {
                ok = password === user.password;
            }

            if (!ok) {
                // Increment login attempts
                user.loginAttempts += 1;
                if (user.loginAttempts >= 5) {
                    user.status = 'locked';
                    user.lockUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 mins lock
                    await user.save();
                    
                    auditService.raw({
                        event: 'user.account_locked',
                        actor: { userId: user._id.toString(), username: user.email, role: 'user' },
                        resource: { type: 'user', id: user._id.toString() },
                        outcome: 'blocked',
                        severity: 'critical',
                        metadata: { message: 'Brute force lockout triggered' }
                    });

                    return res.status(403).json({ 
                        message: 'Account locked due to 5 failed attempts. Please wait 15 minutes.' 
                    });
                }
                await user.save();
                auditService.userLoginFailed(req, email);
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Reset login attempts on success
            user.loginAttempts = 0;
            user.lockUntil = undefined;
            if (user.status === 'locked') user.status = 'active';
            await user.save();

            const { token, jti } = tokenService.signAccessToken({ id: user._id.toString(), email: user.email, role: user.role });
            const refreshInfo = await tokenService.createRefreshToken(user._id.toString(), req);

            res.cookie('refreshToken', refreshInfo.token, tokenService.refreshCookieOptions(refreshInfo.expiresAt));

            auditService.userLogin(req, user);

            return res.json({ 
                id: user._id, 
                email: user.email, 
                token,
                isEmailVerified: user.isEmailVerified,
                fullName: user.fullName || ''
            });
        }

        // File-based fallback
        const users = readJson('users.json', []);
        const user = users.find(u => u.email === email);
        if (!user) return res.status(401).json({ message: 'Invalid credentials' });
        let ok = false;
        if ((user.password || '').startsWith('$2')) {
            ok = await bcrypt.compare(password, user.password);
        } else {
            ok = password === user.password;
        }
        if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
        
        const { token } = tokenService.signAccessToken({ id: user.id, email: user.email, role: 'user' });
        return res.json({ id: user.id, email: user.email, token });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Server error during login' });
    }
});

// Auth: Token Refresh Rotation
app.post('/api/auth/refresh', async (req, res) => {
    const rawRefreshToken = req.cookies?.refreshToken;
    if (!rawRefreshToken) return res.status(401).json({ message: 'Refresh token is missing' });

    try {
        const record = await tokenService.consumeRefreshToken(rawRefreshToken);
        
        // Find user to verify they are still active
        const user = await User.findById(record.userId);
        if (!user || user.status === 'suspended') {
            return res.status(403).json({ message: 'User is suspended or deleted' });
        }

        const { token, jti } = tokenService.signAccessToken({ id: user._id.toString(), email: user.email, role: user.role });
        const refreshInfo = await tokenService.createRefreshToken(user._id.toString(), req, record.family);

        res.cookie('refreshToken', refreshInfo.token, tokenService.refreshCookieOptions(refreshInfo.expiresAt));
        
        auditService.tokenRefresh(req, user._id.toString());

        res.json({ token });
    } catch (error) {
        console.warn('[REFRESH ERROR]', error.message);
        if (error.message.includes('reuse detected')) {
            auditService.tokenReuse(req, null);
        }
        tokenService.clearRefreshCookie(res);
        res.status(401).json({ message: 'Session expired. Please log in again.' });
    }
});

// Auth: Logout
app.post('/api/auth/logout', async (req, res) => {
    const rawRefreshToken = req.cookies?.refreshToken;
    
    // Attempt best-effort access token blacklist
    try {
        const auth = req.headers['authorization'] || '';
        const parts = auth.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            const decoded = jwt.decode(parts[1]);
            if (decoded && decoded.jti) {
                await tokenService.blacklistAccessToken(decoded.jti, decoded.id, decoded.exp, 'logout');
            }
        }
    } catch (_) {}

    try {
        if (rawRefreshToken) {
            // Revoke the refresh token family (logout this device/session)
            const record = await RefreshToken.findOne({ token: rawRefreshToken });
            if (record) {
                await tokenService.revokeFamilyTokens(record.family, 'logout');
                auditService.userLogout(req, { id: record.userId });
            }
        }
    } catch (e) {
        console.error('Logout revocation error:', e.message);
    }

    tokenService.clearRefreshCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
});

// Admin login — now issues a signed JWT, uses bcrypt for password comparison, and logs attempts
app.post('/api/admin/login', security.authLimiter, security.validateAdminLogin, security.handleValidationErrors, async (req, res) => {
    const admins = readJson('admins.json', []);
    const { username, password, code } = req.body || {};
    const admin = admins.find(a => a.username === username && a.code === code);
    
    if (!admin) {
        auditService.adminLoginFailed(req, username);
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    let passwordOk = false;
    if (admin.password && admin.password.startsWith('$2')) {
        passwordOk = await bcrypt.compare(password, admin.password);
    } else {
        passwordOk = (admin.password === password);
    }
    
    if (!passwordOk) {
        auditService.adminLoginFailed(req, username);
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const { token } = tokenService.signAdminToken({ username: admin.username, role: 'admin' });
    auditService.adminLogin(req, admin);
    
    res.json({ token });
});

// Create campaign with Base64 image support
app.post('/api/campaigns', requireAuth, async (req, res) => {
    try {
        const form = new formidable.IncomingForm({ multiples: false });
        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Form parse error:', err);
                return res.status(500).json({ error: 'Failed to parse form data' });
            }

            // Helper to get the first value of a field
            const getFirst = (arr) => (Array.isArray(arr) ? arr[0] : arr);
            const title = getFirst(fields.campaignTitle) || 'Untitled Campaign';
            const description = getFirst(fields.campaignDescription) || getFirst(fields.shortDescription) || '';
            const goal = parseInt(getFirst(fields.fundingGoal) || '0', 10) || 0;
            const days = parseInt(getFirst(fields.campaignDuration) || '30', 10) || 30;
            const location = getFirst(fields.location) || '';
            const category = getFirst(fields.category) || 'General';
            const organizerName = getFirst(fields.organizerName) || '';
            const userId = getFirst(fields.userId) || '';

            // Convert uploaded image to Base64, if present
            let imageBase64 = null;
            const imageFile = files.campaignImage?.[0];
            if (imageFile && imageFile.filepath) {
                try {
                    const imageBytes = fs.readFileSync(imageFile.filepath);
                    const mimeType = imageFile.mimetype || 'image/jpeg';
                    imageBase64 = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
                } catch (readErr) {
                    console.error('Failed to read uploaded image:', readErr);
                }
            }

            const city = getFirst(fields.city) || '';
            const state = getFirst(fields.state) || '';
            const country = getFirst(fields.country) || '';
            const latitude = parseFloat(getFirst(fields.latitude));
            const longitude = parseFloat(getFirst(fields.longitude));

            let locationGeo = undefined;
            if (!isNaN(latitude) && !isNaN(longitude)) {
                locationGeo = {
                    type: 'Point',
                    coordinates: [longitude, latitude]
                };
            }

            const campaignData = {
                title,
                description,
                image: imageBase64,
                goal,
                raised: 0,
                backers: 0,
                daysLeft: days,
                badge: 'New',
                status: 'pending',
                createdAt: new Date(),
                location,
                city,
                state,
                country,
                locationGeo,
                creatorId: userId,
                creatorName: organizerName
            };

            let campaign;
            if (useMongoDb) {
                // Create campaign in MongoDB
                const created = await mongoDb.createCampaign(campaignData);
                campaign = created?.toObject ? created.toObject() : created;
                if (campaign && campaign._id && !campaign.id) {
                    campaign.id = campaign._id.toString();
                }

                // Mirror into file-based store so admin endpoints (which read files) can see it
                const campaigns = readJson('campaigns.json', []);
                const mirror = {
                    id: campaign.id,
                    title: campaign.title,
                    description: campaign.description,
                    image: campaign.image,
                    goal: campaign.goal || 0,
                    raised: 0,
                    backers: 0,
                    daysLeft: campaign.daysLeft || 30,
                    badge: 'New',
                    status: campaign.status || 'pending',
                    createdAt: new Date().toISOString(),
                    location: campaign.location || '',
                    city,
                    state,
                    country,
                    latitude: !isNaN(latitude) ? latitude : undefined,
                    longitude: !isNaN(longitude) ? longitude : undefined,
                    creatorName: campaign.creatorName || '',
                    creatorId: campaign.creatorId || ''
                };
                campaigns.push(mirror);
                writeJson('campaigns.json', campaigns);
            } else {
                // Fallback to file system
                const campaigns = readJson('campaigns.json', []);
                const newId = campaigns.length ? Math.max(...campaigns.map(c => Number(c.id) || 0)) + 1 : 1;
                campaign = {
                    id: newId,
                    ...campaignData,
                    createdAt: new Date().toISOString()
                };
                campaigns.push(campaign);
                writeJson('campaigns.json', campaigns);
            }
            res.status(201).json(campaign);
        });
    } catch (error) {
        console.error('Campaign creation error:', error);
        res.status(500).json({ message: 'Server error during campaign creation' });
    }
});

// KYC submission — now with rate limiting, file type validation, and encrypted Aadhaar/PAN
const secureKycUpload = multer({
    storage,
    fileFilter: security.kycFileFilter,
    limits: { fileSize: security.MAX_FILE_SIZE_BYTES, files: 4 }
});

app.post('/api/kyc', requireAuth, security.kycLimiter, secureKycUpload.fields([
    { name: 'aadhaarFront', maxCount: 1 },
    { name: 'aadhaarBack', maxCount: 1 },
    { name: 'panPhoto', maxCount: 1 },
    { name: 'selfie', maxCount: 1 }
]), security.validateKYC, security.handleValidationErrors, async (req, res) => {
    try {
        const { aadhaarNumber, fullName, panNumber, campaignId } = req.body || {};
        // userId comes from the verified JWT token, not user input
        const userId = req.user?.id || req.body?.userId;
        const files = Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0]?.filename]));

        // Encrypt sensitive identity fields before storage
        let encryptedAadhaar = aadhaarNumber;
        let encryptedPan = panNumber;
        try {
            encryptedAadhaar = security.encryptSensitiveField(aadhaarNumber);
            if (panNumber) encryptedPan = security.encryptSensitiveField(panNumber);
        } catch (encErr) {
            console.warn('[SECURITY] Encryption unavailable — storing without encryption:', encErr.message);
        }
        const maskedAadhaar = security.maskAadhaar(aadhaarNumber);
        
        let record;
        
        if (useMongoDb) {
            // Create KYC record in MongoDB
            // Fallback: if userId is missing/invalid, generate a placeholder so KYC still stores
            let mongoUserId = userId;
            if (!mongoUserId || !mongoose.Types.ObjectId.isValid(mongoUserId)) {
                mongoUserId = new mongoose.Types.ObjectId().toString();
            }
            record = await mongoDb.createKYC({
                userId: mongoUserId,
                aadhaarNumber: encryptedAadhaar,
                fullName: security.sanitiseString(fullName),
                panNumber: encryptedPan,
                maskedAadhaar,
                // Preserve campaignId as string when coming from Mongo/ObjectId
                campaignId: campaignId || undefined,
                files,
                status: 'pending',
                createdAt: new Date()
            });

            // Mirror into file-based store so admin dashboard (and any file-based flows) can see it
            try {
                const kycList = readJson('kyc.json', []);
                const obj = record?.toObject ? record.toObject() : record;
                const mirror = {
                    id: (obj?._id || obj?.id || '').toString(),
                    userId: mongoUserId,
                    aadhaarNumber: obj?.aadhaarNumber || aadhaarNumber || '',
                    fullName: obj?.fullName || fullName || '',
                    panNumber: obj?.panNumber || panNumber || '',
                    // Keep as-is; may be string or number
                    campaignId: typeof (obj?.campaignId ?? campaignId) !== 'undefined' ? (obj?.campaignId ?? campaignId) : undefined,
                    files: obj?.files || files || {},
                    status: obj?.status || 'pending',
                    createdAt: (obj?.createdAt ? new Date(obj.createdAt).toISOString() : new Date().toISOString())
                };
                kycList.push(mirror);
                writeJson('kyc.json', kycList);
            } catch (_) { /* non-fatal mirroring failure */ }
        } else {
            // Fallback to file system
            const kycList = readJson('kyc.json', []);
            record = {
                id: kycList.length ? Math.max(...kycList.map(k => Number(k.id) || 0)) + 1 : 1,
                userId,
                aadhaarNumber: encryptedAadhaar,
                maskedAadhaar,
                fullName: security.sanitiseString(fullName),
                panNumber: encryptedPan,
                campaignId: campaignId ? Number(campaignId) : undefined,
                files,
                status: 'pending',
                createdAt: new Date().toISOString()
            };
            kycList.push(record);
            writeJson('kyc.json', kycList);
        }

        res.status(201).json({ success: true, status: record.status, campaignId: record.campaignId, id: record.id || record._id });
    } catch (error) {
        console.error('KYC submission error:', error);
        res.status(500).json({ message: 'Server error during KYC submission' });
    }
});

// Admin: list KYC submissions
app.get('/api/admin/kyc', security.requireAdminAuth, async (req, res) => {
    try {
        // Disable caching to ensure the admin dashboard always sees fresh KYC data
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        // Always prepare file-based list as a baseline
        const fileList = readJson('kyc.json', []);

        if (useMongoDb) {
            const mongoList = await mongoDb.getKYCs();
            const mappedMongo = mongoList.map(item => ({
                ...(item.toObject ? item.toObject() : item),
                id: (item._id || item.id).toString()
            }));

            // Concatenate Mongo and file lists, then deduplicate so admin sees at most one KYC per Aadhaar/user
            const combined = [
                ...mappedMongo,
                ...((fileList || []).map(f => ({
                    ...f,
                    id: (f.id || '').toString()
                })))
            ];

            const groups = new Map();
            for (const k of combined) {
                const aadhaar = String(k.aadhaarNumber || '').trim();
                const userKey = String(k.userId || '').trim();
                const key = aadhaar || userKey || String(k.id || '').toString();
                if (!key) continue;

                const existing = groups.get(key);
                if (!existing) {
                    groups.set(key, k);
                } else {
                    const tNew = new Date(k.createdAt || 0).getTime();
                    const tOld = new Date(existing.createdAt || 0).getTime();
                    if (tNew >= tOld) groups.set(key, k);
                }
            }

            const deduped = Array.from(groups.values());
            const sorted = deduped.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            return res.json(sorted);
        }

        // No Mongo: return file list only
        const groups = new Map();
        for (const k of (fileList || [])) {
            const aadhaar = String(k.aadhaarNumber || '').trim();
            const userKey = String(k.userId || '').trim();
            const key = aadhaar || userKey || String(k.id || '').toString();
            if (!key) continue;

            const existing = groups.get(key);
            if (!existing) {
                groups.set(key, k);
            } else {
                const tNew = new Date(k.createdAt || 0).getTime();
                const tOld = new Date(existing.createdAt || 0).getTime();
                if (tNew >= tOld) groups.set(key, k);
            }
        }
        const dedupedFile = Array.from(groups.values());
        const sortedFile = dedupedFile.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.json(sortedFile);
    } catch (e) {
        console.error('Error fetching admin KYC list:', e);
        res.status(500).json({ message: 'Failed to fetch KYC list' });
    }
});

// Admin: update KYC status (verified/rejected) and propagate to campaign
app.put('/api/admin/kyc/:id/status', security.requireAdminAuth, async (req, res) => {
    const { status, reason } = req.body || {};
    if (!['verified', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be verified or rejected' });
    }

    try {
        if (useMongoDb) {
            // Update in MongoDB
            const updated = await mongoDb.updateKYC(req.params.id, {
                status,
                verifiedAt: status === 'verified' ? new Date() : undefined,
                rejectedAt: status === 'rejected' ? new Date() : undefined,
                reason: status === 'rejected' ? reason : undefined
            });
            if (!updated) return res.status(404).json({ message: 'KYC record not found' });

            // Mark user as KYC verified in Users collection
            if (updated.userId) {
                try {
                    await mongoDb.updateUser(updated.userId, { isKYCVerified: status === 'verified' });
                } catch (_) {}

                // Mirror user's KYC status into file-based users.json
                try {
                    const users = readJson('users.json', []);
                    const user = users.find(u => String(u.id) === String(updated.userId));
                    if (user) {
                        user.isKYCVerified = status === 'verified';
                        writeJson('users.json', users);
                    }
                } catch (_) { /* non-fatal mirror failure */ }
            }

            // Mirror KYC status into file-based kyc.json so admin flows that read files can see it
            try {
                const list = readJson('kyc.json', []);
                const idStr = (updated._id || updated.id || '').toString();
                let changed = false;
                for (const item of list) {
                    if (String(item.id) === idStr) {
                        item.status = status;
                        if (status === 'verified') item.verifiedAt = new Date().toISOString();
                        if (status === 'rejected') item.rejectedAt = new Date().toISOString();
                        if (reason) item.reason = reason;
                        changed = true;
                        break;
                    }
                }
                if (changed) writeJson('kyc.json', list);
            } catch (_) { /* non-fatal mirror failure */ }

            // Update linked campaign in file storage (since campaigns are file-based here)
            if (updated.campaignId) {
                const campaigns = readJson('campaigns.json', []);
                const campaign = campaigns.find(c => String(c.id) === String(updated.campaignId));
                if (campaign) {
                    if (status === 'verified') {
                        // Keep campaign pending; admin will explicitly approve/reject later
                        if (campaign.status !== 'rejected') {
                            campaign.status = 'pending';
                        }
                        campaign.kycStatus = 'verified';
                    } else if (status === 'rejected') {
                        campaign.status = 'rejected';
                        if (reason) campaign.rejectionReason = reason;
                    }
                    campaign.reviewedAt = new Date().toISOString();
                    writeJson('campaigns.json', campaigns);
                }
            } else if (status === 'verified' && updated.userId) {
                // No explicit campaignId on KYC: mark creator's campaigns as ready for review
                const campaigns = readJson('campaigns.json', []);
                let changed = false;
                for (const c of campaigns) {
                    if (String(c.creatorId || '') === String(updated.userId)) {
                        if (c.status !== 'rejected') {
                            c.status = 'pending';
                        }
                        c.kycStatus = 'verified';
                        c.reviewedAt = new Date().toISOString();
                        changed = true;
                    }
                }
                if (changed) writeJson('campaigns.json', campaigns);
            }

            // After verification, remove duplicate KYC submissions by Aadhaar number (keep the verified one)
            if (status === 'verified' && (updated.aadhaarNumber || '').trim()) {
                try {
                    const aadhaar = String(updated.aadhaarNumber).trim();
                    // Mongo cleanup
                    try {
                        const all = await mongoDb.getKYCs();
                        const toDelete = (all || [])
                            .filter(k => String(k.aadhaarNumber || '').trim() === aadhaar && String((k._id || k.id)).toString() !== String(updated._id || updated.id))
                            .map(k => (k._id || k.id).toString());
                        if (toDelete.length) {
                            await mongoDb.deleteKYCsByIds(toDelete);
                        }
                    } catch (_) {}
                    // File cleanup mirror
                    try {
                        const list = readJson('kyc.json', []);
                        const filtered = (list || []).filter(k => String(k.aadhaarNumber || '').trim() !== aadhaar || String(k.id) === String(updated._id || updated.id));
                        if (filtered.length !== (list || []).length) writeJson('kyc.json', filtered);
                    } catch (_) {}
                } catch (_) {}
            }
            return res.json({ success: true, kyc: updated });
        }

        // File-system fallback
        const kycList = readJson('kyc.json', []);
        const kyc = kycList.find(k => String(k.id) === String(req.params.id));
        if (!kyc) return res.status(404).json({ message: 'KYC record not found' });
        kyc.status = status;
        if (status === 'verified') {
            kyc.verifiedAt = new Date().toISOString();
        } else if (status === 'rejected') {
            kyc.rejectedAt = new Date().toISOString();
            if (reason) kyc.reason = reason;
        }
        writeJson('kyc.json', kycList);

        // Mark user as verified in users.json when possible
        if (kyc.userId) {
            const users = readJson('users.json', []);
            const user = users.find(u => String(u.id) === String(kyc.userId));
            if (user) {
                user.isKYCVerified = status === 'verified';
                writeJson('users.json', users);
            }
        }

        if (kyc.campaignId) {
            const campaigns = readJson('campaigns.json', []);
            const campaign = campaigns.find(c => String(c.id) === String(kyc.campaignId));
            if (campaign) {
                if (status === 'verified') {
                    if (campaign.status !== 'rejected') {
                        campaign.status = 'pending';
                    }
                    campaign.kycStatus = 'verified';
                } else if (status === 'rejected') {
                    campaign.status = 'rejected';
                    if (reason) campaign.rejectionReason = reason;
                }
                campaign.reviewedAt = new Date().toISOString();
                writeJson('campaigns.json', campaigns);
            }
        } else if (status === 'verified' && kyc.userId) {
            // No explicit campaignId: mark creator's campaigns as ready for review
            const campaigns = readJson('campaigns.json', []);
            let changed = false;
            for (const c of campaigns) {
                if (String(c.creatorId || '') === String(kyc.userId)) {
                    if (c.status !== 'rejected') {
                        c.status = 'pending';
                    }
                    c.kycStatus = 'verified';
                    c.reviewedAt = new Date().toISOString();
                    changed = true;
                }
            }
            if (changed) writeJson('campaigns.json', campaigns);
        }

        // After verification, remove duplicate KYC submissions by Aadhaar number (keep the verified one) in file store
        if (status === 'verified' && (kyc.aadhaarNumber || '').trim()) {
            try {
                const aadhaar = String(kyc.aadhaarNumber).trim();
                const list = readJson('kyc.json', []);
                const filtered = (list || []).filter(k => String(k.aadhaarNumber || '').trim() !== aadhaar || String(k.id) === String(kyc.id));
                if (filtered.length !== (list || []).length) writeJson('kyc.json', filtered);
            } catch (_) {}
        }
        res.json({ success: true, kyc });
    } catch (e) {
        console.error('Error updating KYC status:', e);
        res.status(500).json({ message: 'Failed to update KYC status' });
    }
});

// Contact messages — with validation and input sanitisation
app.post('/api/contact', security.generalLimiter, security.validateContactForm, security.handleValidationErrors, (req, res) => {
    const messages = readJson('messages.json', []);
    const { firstName, lastName, email, subject, message } = req.body || {};
    const record = {
        id: messages.length ? Math.max(...messages.map(m => Number(m.id) || 0)) + 1 : 1,
        firstName: security.sanitiseString(firstName),
        lastName: security.sanitiseString(lastName),
        email,
        subject: security.sanitiseString(subject),
        message: security.sanitiseString(message),
        createdAt: new Date().toISOString()
    };
    messages.push(record);
    writeJson('messages.json', messages);
    res.status(201).json({ success: true });
});

// ─── Campaign Verification Workflow & Escrow Admin APIs ───────────────────

// Public: Request campaign verification
app.post('/api/campaigns/:id/verify-request', requireAuth, async (req, res) => {
    const campaignId = req.params.id;
    try {
        if (useMongoDb) {
            const campaign = await Campaign.findById(campaignId);
            if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
            
            // Ensure requester is owner
            if (campaign.creatorId.toString() !== req.user.id) {
                return res.status(403).json({ message: 'You are not authorized to verify this campaign' });
            }
            
            campaign.verificationStatus = 'pending';
            campaign.verificationRequestedAt = new Date();
            await campaign.save();
            
            // Mirror to file store
            const campaignsFile = readJson('campaigns.json', []);
            const match = campaignsFile.find(c => String(c.id) === String(campaignId));
            if (match) {
                match.verificationStatus = 'pending';
                match.verificationRequestedAt = new Date().toISOString();
                writeJson('campaigns.json', campaignsFile);
            }
            
            // Log audit
            auditService.raw({
                event: 'campaign.verification_requested',
                actor: { ...auditService.actorFromReq(req) },
                resource: { type: 'campaign', id: campaignId },
                severity: 'info',
                outcome: 'success'
            });
            
            // Notify admins
            const io = req.app.get('io');
            if (io) {
                io.emit('admin_notification', {
                    type: 'verification_requested',
                    message: `Verification requested for campaign "${campaign.title}"`,
                    campaignId
                });
            }
            
            return res.json({ success: true, message: 'Verification request submitted.', campaign });
        }
        
        // File fallback
        const campaignsFile = readJson('campaigns.json', []);
        const campaign = campaignsFile.find(c => String(c.id) === String(campaignId));
        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
        
        campaign.verificationStatus = 'pending';
        campaign.verificationRequestedAt = new Date().toISOString();
        writeJson('campaigns.json', campaignsFile);
        
        res.json({ success: true, message: 'Verification request submitted.', campaign });
    } catch (error) {
        console.error('Request verification error:', error);
        res.status(500).json({ message: 'Failed to request verification' });
    }
});

// Admin: Get all pending campaign verification requests
app.get('/api/admin/campaigns/verification-pending', security.requireAdminAuth, async (req, res) => {
    try {
        if (useMongoDb) {
            const list = await Campaign.find({ verificationStatus: 'pending' }).populate('creatorId', 'username email');
            const results = list.map(item => {
                const obj = item.toObject();
                obj.id = obj._id.toString();
                return obj;
            });
            return res.json(results);
        }
        
        const campaigns = readJson('campaigns.json', []);
        const filtered = campaigns.filter(c => c.verificationStatus === 'pending');
        res.json(filtered);
    } catch (error) {
        console.error('Fetch pending verifications error:', error);
        res.status(500).json({ message: 'Failed to fetch verification requests' });
    }
});

// Admin: Approve campaign verification
app.post('/api/admin/campaigns/:id/verify-approve', security.requireAdminAuth, async (req, res) => {
    const campaignId = req.params.id;
    const { notes } = req.body || {};
    
    try {
        if (useMongoDb) {
            const campaign = await Campaign.findById(campaignId);
            if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
            
            campaign.isVerified = true;
            campaign.verificationStatus = 'approved';
            campaign.verifiedAt = new Date();
            campaign.verificationNotes = notes || 'Compliance verified.';
            await campaign.save();
            
            // Mirror
            const campaignsFile = readJson('campaigns.json', []);
            const match = campaignsFile.find(c => String(c.id) === String(campaignId));
            if (match) {
                match.isVerified = true;
                match.verificationStatus = 'approved';
                match.verifiedAt = new Date().toISOString();
                match.verificationNotes = campaign.verificationNotes;
                writeJson('campaigns.json', campaignsFile);
            }
            
            // Audit Log
            auditService.raw({
                event: 'campaign.verified',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'campaign', id: campaignId },
                metadata: { notes },
                severity: 'info',
                outcome: 'success'
            });
            
            // Notify campaign owner via socket
            const io = req.app.get('io');
            if (io) {
                io.to(campaign.creatorId.toString()).emit('notification', {
                    type: 'verification_approved',
                    message: `Congratulations! Your campaign "${campaign.title}" has been verified.`,
                    campaignId
                });
            }
            
            return res.json({ success: true, message: 'Campaign successfully verified', campaign });
        }
        
        // File fallback
        const campaignsFile = readJson('campaigns.json', []);
        const campaign = campaignsFile.find(c => String(c.id) === String(campaignId));
        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
        
        campaign.isVerified = true;
        campaign.verificationStatus = 'approved';
        campaign.verifiedAt = new Date().toISOString();
        campaign.verificationNotes = notes || 'Compliance verified.';
        writeJson('campaigns.json', campaignsFile);
        
        res.json({ success: true, message: 'Campaign successfully verified', campaign });
    } catch (error) {
        console.error('Approve verification error:', error);
        res.status(500).json({ message: 'Failed to verify campaign' });
    }
});

// Admin: Reject campaign verification
app.post('/api/admin/campaigns/:id/verify-reject', security.requireAdminAuth, async (req, res) => {
    const campaignId = req.params.id;
    const { notes } = req.body || {};
    
    if (!notes || !notes.trim()) {
        return res.status(400).json({ message: 'Rejection notes are required' });
    }
    
    try {
        if (useMongoDb) {
            const campaign = await Campaign.findById(campaignId);
            if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
            
            campaign.isVerified = false;
            campaign.verificationStatus = 'rejected';
            campaign.verificationNotes = notes;
            await campaign.save();
            
            // Mirror
            const campaignsFile = readJson('campaigns.json', []);
            const match = campaignsFile.find(c => String(c.id) === String(campaignId));
            if (match) {
                match.isVerified = false;
                match.verificationStatus = 'rejected';
                match.verificationNotes = notes;
                writeJson('campaigns.json', campaignsFile);
            }
            
            // Audit Log
            auditService.raw({
                event: 'campaign.verification_rejected',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'campaign', id: campaignId },
                metadata: { notes },
                severity: 'warning',
                outcome: 'success'
            });
            
            // Notify campaign owner via socket
            const io = req.app.get('io');
            if (io) {
                io.to(campaign.creatorId.toString()).emit('notification', {
                    type: 'verification_rejected',
                    message: `Verification for your campaign "${campaign.title}" was declined. Reason: ${notes}`,
                    campaignId
                });
            }
            
            return res.json({ success: true, message: 'Campaign verification declined', campaign });
        }
        
        // File fallback
        const campaignsFile = readJson('campaigns.json', []);
        const campaign = campaignsFile.find(c => String(c.id) === String(campaignId));
        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
        
        campaign.isVerified = false;
        campaign.verificationStatus = 'rejected';
        campaign.verificationNotes = notes;
        writeJson('campaigns.json', campaignsFile);
        
        res.json({ success: true, message: 'Campaign verification declined', campaign });
    } catch (error) {
        console.error('Reject verification error:', error);
        res.status(500).json({ message: 'Failed to reject verification request' });
    }
});

// Admin: List all donations
app.get('/api/admin/donations', security.requireAdminAuth, async (req, res) => {
    try {
        const { status, campaignId } = req.query;
        if (useMongoDb) {
            const query = {};
            if (status) query.status = status;
            if (campaignId) query.campaignId = campaignId;
            const list = await Donation.find(query).populate('campaignId', 'title goal raised').sort({ createdAt: -1 });
            return res.json(list);
        }
        
        const list = readJson('donations.json', []);
        let filtered = list;
        if (status) filtered = filtered.filter(d => d.status === status);
        if (campaignId) filtered = filtered.filter(d => String(d.campaignId) === String(campaignId));
        return res.json(filtered.reverse());
    } catch (error) {
        console.error('Fetch donations error:', error);
        res.status(500).json({ message: 'Failed to retrieve donations' });
    }
});

// Admin: Get campaign escrow status
app.get('/api/admin/campaigns/:id/escrow', security.requireAdminAuth, async (req, res) => {
    const campaignId = req.params.id;
    try {
        if (useMongoDb) {
            const campaign = await Campaign.findById(campaignId);
            if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
            
            const donations = await Donation.find({ campaignId });
            const totalHeld = donations.filter(d => d.status === 'held').reduce((sum, d) => sum + d.amount, 0);
            const totalReleased = donations.filter(d => d.status === 'released').reduce((sum, d) => sum + d.amount, 0);
            const totalRefunded = donations.filter(d => d.status === 'refunded').reduce((sum, d) => sum + d.amount, 0);
            
            return res.json({
                campaignId,
                title: campaign.title,
                goal: campaign.goal,
                totalRaised: campaign.raised,
                totalHeld,
                totalReleased,
                totalRefunded,
                goalAchieved: campaign.raised >= campaign.goal
            });
        }
        
        // File fallback
        const campaignsFile = readJson('campaigns.json', []);
        const campaign = campaignsFile.find(c => String(c.id) === String(campaignId));
        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
        
        const donationsFile = readJson('donations.json', []);
        const list = donationsFile.filter(d => String(d.campaignId) === String(campaignId));
        const totalHeld = list.filter(d => d.status === 'held').reduce((sum, d) => sum + d.amount, 0);
        const totalReleased = list.filter(d => d.status === 'released').reduce((sum, d) => sum + d.amount, 0);
        const totalRefunded = list.filter(d => d.status === 'refunded').reduce((sum, d) => sum + d.amount, 0);
        
        return res.json({
            campaignId,
            title: campaign.title,
            goal: campaign.goal,
            totalRaised: campaign.raised,
            totalHeld,
            totalReleased,
            totalRefunded,
            goalAchieved: campaign.raised >= campaign.goal
        });
    } catch (error) {
        console.error('Fetch escrow error:', error);
        res.status(500).json({ message: 'Failed to fetch escrow details' });
    }
});

// Admin: Release a held donation
app.post('/api/admin/donations/:id/release', security.requireAdminAuth, async (req, res) => {
    try {
        const donationId = req.params.id;
        let donation;
        let campaignId;
        
        if (useMongoDb) {
            donation = await Donation.findById(donationId).populate('campaignId');
            if (!donation) return res.status(404).json({ message: 'Donation not found' });
            if (donation.status !== 'held') {
                return res.status(400).json({ message: `Donation cannot be released (current status: ${donation.status})` });
            }
            
            // Check if goal achieved (Required unless overridden)
            const campaign = donation.campaignId;
            if (campaign.raised < campaign.goal && !req.body.force) {
                return res.status(400).json({ 
                    message: `Campaign goal has not been reached yet (Goal: ₹${campaign.goal}, Raised: ₹${campaign.raised}). Release blocked.` 
                });
            }
            
            donation.status = 'released';
            donation.releaseApprovedBy = req.user?.username || 'admin';
            donation.releaseApprovedAt = new Date();
            donation.statusTimeline.push({
                status: 'released',
                updatedBy: req.user?.username || 'admin',
                note: req.body.note || 'Manually approved for release by Admin.'
            });
            await donation.save();
            campaignId = campaign._id.toString();
            
            // Audit Log
            auditService.raw({
                event: 'payment.release',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'donation', id: donation._id.toString() },
                metadata: { campaignId, amount: donation.amount },
                severity: 'info',
                outcome: 'success'
            });
            
            // Notify via socket
            const io = req.app.get('io');
            if (io) {
                io.to(campaign.creatorId.toString()).emit('notification', {
                    type: 'funds_released',
                    message: `Funds of ₹${donation.amount} from donor ${donation.donorName} have been released to your account.`,
                    campaignId: campaignId
                });
            }
        } else {
            // File fallback
            const donationsFile = readJson('donations.json', []);
            donation = donationsFile.find(d => String(d.id) === String(donationId));
            if (!donation) return res.status(404).json({ message: 'Donation not found' });
            if (donation.status !== 'held') {
                return res.status(400).json({ message: `Donation cannot be released (status: ${donation.status})` });
            }
            
            const campaignsFile = readJson('campaigns.json', []);
            const campaign = campaignsFile.find(c => String(c.id) === String(donation.campaignId));
            if (campaign && campaign.raised < campaign.goal && !req.body.force) {
                return res.status(400).json({ message: 'Campaign goal not reached yet. Release blocked.' });
            }
            
            donation.status = 'released';
            donation.releasedAt = new Date().toISOString();
            writeJson('donations.json', donationsFile);
            campaignId = donation.campaignId;
        }
        
        res.json({ success: true, message: 'Donation released successfully', donation });
    } catch (error) {
        console.error('Release donation error:', error);
        res.status(500).json({ message: 'Failed to release donation' });
    }
});

// Admin: Refund a donation
app.post('/api/admin/donations/:id/refund', security.requireAdminAuth, async (req, res) => {
    try {
        const donationId = req.params.id;
        let donation;
        let campaignId;
        let amount;
        
        if (useMongoDb) {
            donation = await Donation.findById(donationId);
            if (!donation) return res.status(404).json({ message: 'Donation not found' });
            if (['pending', 'refunded'].includes(donation.status)) {
                return res.status(400).json({ message: `Donation cannot be refunded (current status: ${donation.status})` });
            }
            
            donation.status = 'refunded';
            donation.statusTimeline.push({
                status: 'refunded',
                updatedBy: req.user?.username || 'admin',
                note: req.body.note || 'Refund processed by administrator.'
            });
            await donation.save();
            campaignId = donation.campaignId.toString();
            amount = donation.amount;
            
            // Deduct from campaign totals
            const campaign = await Campaign.findById(campaignId);
            if (campaign) {
                campaign.raised = Math.max(0, campaign.raised - amount);
                campaign.backers = Math.max(0, campaign.backers - 1);
                await campaign.save();
                
                // Sync file store
                const campaignsFile = readJson('campaigns.json', []);
                const match = campaignsFile.find(c => String(c.id) === String(campaignId));
                if (match) {
                    match.raised = campaign.raised;
                    match.backers = campaign.backers;
                    writeJson('campaigns.json', campaignsFile);
                }
            }
            
            // Audit Log
            auditService.raw({
                event: 'payment.refund',
                actor: { ...auditService.actorFromReq(req), role: 'admin' },
                resource: { type: 'donation', id: donation._id.toString() },
                metadata: { campaignId, amount },
                severity: 'warning',
                outcome: 'success'
            });
        } else {
            // File fallback
            const donationsFile = readJson('donations.json', []);
            donation = donationsFile.find(d => String(d.id) === String(donationId));
            if (!donation) return res.status(404).json({ message: 'Donation not found' });
            if (['pending', 'refunded'].includes(donation.status)) {
                return res.status(400).json({ message: `Donation cannot be refunded (status: ${donation.status})` });
            }
            
            donation.status = 'refunded';
            writeJson('donations.json', donationsFile);
            campaignId = donation.campaignId;
            amount = donation.amount;
            
            // Deduct campaign totals in files
            const campaignsFile = readJson('campaigns.json', []);
            const campaign = campaignsFile.find(c => String(c.id) === String(campaignId));
            if (campaign) {
                campaign.raised = Math.max(0, campaign.raised - amount);
                campaign.backers = Math.max(0, campaign.backers - 1);
                writeJson('campaigns.json', campaignsFile);
            }
        }
        
        res.json({ success: true, message: 'Donation refunded successfully', donation });
    } catch (error) {
        console.error('Refund donation error:', error);
        res.status(500).json({ message: 'Failed to process refund' });
    }
});

// Serve static files from uploads directory
app.use('/uploads', express.static(UPLOADS_DIR));

// Fallback for missing uploads: return placeholder image
app.use('/uploads/*', (req, res) => {
    // If the file doesn't exist, return a placeholder SVG or 404
    res.status(404).send('Image not found');
});

// Serve frontend statically so visiting http://localhost:4000/ loads the site
if (fs.existsSync(FRONTEND_DIR)) {
    app.use(express.static(FRONTEND_DIR));
    app.get('/', (req, res) => {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    });
}

// ─── Global error handler (never leak stack traces to client) ────────────────
app.use((err, req, res, next) => {
    // Multer file-filter rejections
    if (err && err.message && err.message.includes('Only JPEG')) {
        return res.status(400).json({ message: err.message });
    }
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File too large. Maximum allowed size is 5 MB.' });
    }
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ message: 'An internal server error occurred.' });
});

// Create HTTP server for Socket.IO
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*', // Allow connections from any origin
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    }
});

// Attach io instance to the app
app.set('io', io);

// Socket.IO event handler
io.on('connection', (socket) => {
    console.log(`[SOCKET.IO] Client connected: ${socket.id}`);
    
    socket.on('join', (room) => {
        socket.join(room);
        console.log(`[SOCKET.IO] Client ${socket.id} joined room: ${room}`);
    });
    
    socket.on('disconnect', () => {
        console.log(`[SOCKET.IO] Client disconnected: ${socket.id}`);
    });
});

// Start server using the HTTP/Socket.IO server instance
server.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
    console.log(`[SOCKET.IO] Server is bound and active.`);
    if (process.env.NODE_ENV === 'production') {
        console.log('[SECURITY] Running in PRODUCTION mode — debug output suppressed.');
    }
});