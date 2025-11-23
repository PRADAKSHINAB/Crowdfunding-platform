const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const formidable = require('formidable');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
require('dotenv').config();

// Import MongoDB connection and utilities
const { connectMongoDB, mongoDb, migrateData } = require('./mongodb');

const app = express();

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
app.get('/api/admin/users', async (req, res) => {
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
app.delete('/api/admin/kyc/deduplicate', async (req, res) => {
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
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Basic middleware
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// JWT helpers
function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function requireAuth(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const parts = auth.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({ message: 'Authorization header missing or invalid' });
        }
        const token = parts[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
}

// Storage paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'crowdfunding');

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
    if (!admins) writeJson('admins.json', [{ username: 'admin', password: 'admin123', code: 'GREENFUND2024' }]);

    const settings = readJson('settings.json', null);
    if (!settings) writeJson('settings.json', { autoApprovalThreshold: 5000, reviewTime: 48 });
}

ensureSeeds();

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Campaigns
app.get('/api/campaigns', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    const { status } = req.query;
    
    if (status) {
        const filtered = campaigns.filter(c => c.status === status);
        res.json(filtered);
    } else {
        // Only return approved campaigns for public view
        const publicCampaigns = campaigns.filter(c => c.status === 'approved');
        res.json(publicCampaigns);
    }
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
app.get('/api/admin/campaigns', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    // Return all campaigns so admin can view every launch (pending/approved/rejected)
    res.json(campaigns);
});

// Admin: Update campaign status (approve/reject)
app.put('/api/admin/campaigns/:id/status', (req, res) => {
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
app.get('/api/admin/pending-count', (req, res) => {
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
app.get('/api/admin/users-count', async (req, res) => {
    try {
        const users = await mongoDb.getUsers();
        return res.json({ totalUsers: Array.isArray(users) ? users.length : 0 });
    } catch (e) {
        console.log('Mongo getUsers failed:', e.message);
    }
    const usersFile = readJson('users.json', []);
    return res.json({ totalUsers: (usersFile || []).length });
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

app.post('/api/campaigns/:id/create-order', async (req, res) => {
    try {
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

// Verify Payment and Save Donation (Step 2: After payment success)
app.post('/api/campaigns/:id/verify-payment', async (req, res) => {
    try {
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
        const paymentStatus = (paymentInfo?.status || '').toLowerCase();
        const normalizedStatus = paymentStatus === 'captured' || paymentStatus === 'authorized' ? 'completed' : (paymentStatus || 'completed');

        // Payment is verified - now save the donation
        const campaigns = readJson('campaigns.json', []);
        const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        const donations = readJson('donations.json', []);
        const donation = {
            id: donations.length ? Math.max(...donations.map(d => Number(d.id) || 0)) + 1 : 1,
            campaignId: campaign.id,
            amount: paidRupees,
            donorName: donorName || 'Anonymous',
            donorEmail: donorEmail || '',
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            createdAt: new Date().toISOString(),
            status: normalizedStatus || 'completed'
        };
        donations.push(donation);
        writeJson('donations.json', donations);

        // Update campaign totals (file store)
        if (donation.status === 'completed') {
            campaign.raised += donation.amount;
            campaign.backers += 1;
        }
        writeJson('campaigns.json', campaigns);

        // Update campaign totals in MongoDB if available
        if (useMongoDb) {
            try {
                if (donation.status === 'completed') {
                    await mongoDb.incrementCampaignStats(campaign.id, donation.amount);
                }
            } catch (e) {
                console.log('Mongo incrementCampaignStats failed:', e.message);
            }
        }

        res.json({ 
            success: true, 
            message: 'Payment verified and donation recorded',
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

// Auth
app.post('/api/auth/register', async (req, res) => {
    const { firstName, lastName, email, phone, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    
    try {
        if (useMongoDb) {
            // Check if email already exists in MongoDB
            try {
                const existingUser = await mongoDb.getUserByEmail(email);
                if (existingUser) {
                    return res.status(409).json({ message: 'Email already registered' });
                }
            } catch (error) {
                console.log('Error checking existing user:', error);
                // Continue with registration even if check fails
            }
            
            // Create new user in MongoDB (password hashed via pre-save)
            try {
                const user = await mongoDb.createUser({
                    username: email.split('@')[0], // Generate username from email
                    firstName: firstName || '',
                    lastName: lastName || '',
                    email,
                    phone: phone || '',
                    password,
                    fullName: `${firstName || ''} ${lastName || ''}`.trim(),
                    createdAt: new Date()
                });
                
                const token = signToken({ id: user._id.toString(), email: user.email });
                res.status(201).json({ id: user._id, email: user.email, token });
                return;
            } catch (error) {
                console.error('Error creating user:', error);
                return res.status(500).json({ message: 'Registration failed. Please try again.' });
            }
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
                createdAt: new Date().toISOString()
            };
            users.push(user);
            writeJson('users.json', users);
            const token = signToken({ id: user.id, email: user.email });
            res.status(201).json({ id: user.id, email: user.email, token });
        }
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    try {
        if (useMongoDb) {
            const user = await mongoDb.getUserByEmail(email);
            if (!user) return res.status(401).json({ message: 'Invalid credentials' });
            // If comparePassword exists use it; else fallback
            let ok = false;
            if (typeof user.comparePassword === 'function') {
                ok = await user.comparePassword(password);
            } else {
                ok = password === user.password;
            }
            if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
            const token = signToken({ id: user._id.toString(), email: user.email });
            return res.json({ id: user._id, email: user.email, token });
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
        const token = signToken({ id: user.id, email: user.email });
        return res.json({ id: user.id, email: user.email, token });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Server error during login' });
    }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const admins = readJson('admins.json', []);
    const { username, password, code } = req.body || {};
    const ok = admins.find(a => a.username === username && a.password === password && a.code === code);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ token: `admin_${Date.now()}` });
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
                category,
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
                    category: campaign.category || 'General',
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

// KYC submission (stores minimal info and uploaded files)
app.post('/api/kyc', upload.fields([
    { name: 'aadhaarFront', maxCount: 1 },
    { name: 'aadhaarBack', maxCount: 1 },
    { name: 'panPhoto', maxCount: 1 },
    { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
    try {
        const { aadhaarNumber, fullName, panNumber, campaignId, userId } = req.body || {};
        const files = Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0]?.filename]));
        
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
                aadhaarNumber,
                fullName,
                panNumber,
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
                aadhaarNumber,
                fullName,
                panNumber,
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
app.get('/api/admin/kyc', async (req, res) => {
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
app.put('/api/admin/kyc/:id/status', async (req, res) => {
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

// Contact messages
app.post('/api/contact', (req, res) => {
    const messages = readJson('messages.json', []);
    const { firstName, lastName, email, subject, message } = req.body || {};
    const record = {
        id: messages.length ? Math.max(...messages.map(m => Number(m.id) || 0)) + 1 : 1,
        firstName, lastName, email, subject, message,
        createdAt: new Date().toISOString()
    };
    messages.push(record);
    writeJson('messages.json', messages);
    res.status(201).json({ success: true });
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

// Start server
app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
});
