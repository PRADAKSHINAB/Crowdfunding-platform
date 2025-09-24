const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

// Basic middleware
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

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
                goal: 20000,
                raised: 15000,
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
                goal: 100000,
                raised: 45000,
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
                goal: 200000,
                raised: 180000,
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

// Admin: Get all campaigns (including pending/rejected)
app.get('/api/admin/campaigns', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
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
    const pendingCount = campaigns.filter(c => c.status === 'pending').length;
    res.json({ pendingCount });
});

app.get('/api/campaigns/:id', (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
    if (!campaign) return res.status(404).json({ message: 'Not found' });
    res.json(campaign);
});

app.post('/api/campaigns', upload.fields([
    { name: 'campaignImage', maxCount: 1 },
    { name: 'additionalImages', maxCount: 5 }
]), (req, res) => {
    const campaigns = readJson('campaigns.json', []);
    const body = req.body || {};
    const newId = campaigns.length ? Math.max(...campaigns.map(c => Number(c.id) || 0)) + 1 : 1;
    const imageFile = req.files && req.files.campaignImage && req.files.campaignImage[0];
    const imageUrl = imageFile ? `/uploads/${imageFile.filename}` : body.image || '';
    const days = parseInt(body.campaignDuration || '30', 10) || 30;

    const campaign = {
        id: newId,
        title: body.campaignTitle || 'Untitled Campaign',
        description: body.campaignDescription || body.shortDescription || '',
        image: imageUrl,
        goal: parseInt(body.fundingGoal || '0', 10) || 0,
        raised: 0,
        backers: 0,
        daysLeft: days,
        badge: 'New',
        status: 'pending',
        createdAt: new Date().toISOString(),
        location: body.location || '',
        category: body.category || 'General'
    };
    campaigns.push(campaign);
    writeJson('campaigns.json', campaigns);
    res.status(201).json(campaign);
});

// Donations
app.post('/api/campaigns/:id/donations', (req, res) => {
    const { amount, donorName, donorEmail } = req.body || {};
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) return res.status(400).json({ message: 'Invalid amount' });
    const campaigns = readJson('campaigns.json', []);
    const campaign = campaigns.find(c => String(c.id) === String(req.params.id));
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

    const donations = readJson('donations.json', []);
    const donation = {
        id: donations.length ? Math.max(...donations.map(d => Number(d.id) || 0)) + 1 : 1,
        campaignId: campaign.id,
        amount: amt,
        donorName: donorName || 'Anonymous',
        donorEmail: donorEmail || '',
        createdAt: new Date().toISOString(),
        status: 'completed'
    };
    donations.push(donation);
    writeJson('donations.json', donations);

    campaign.raised += amt;
    campaign.backers += 1;
    writeJson('campaigns.json', campaigns);

    res.status(201).json({ success: true, donation, campaign });
});

// Auth (basic demo-level)
app.post('/api/auth/register', (req, res) => {
    const users = readJson('users.json', []);
    const { firstName, lastName, email, phone, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    if (users.find(u => u.email === email)) return res.status(409).json({ message: 'Email already registered' });
    const user = {
        id: users.length ? Math.max(...users.map(u => Number(u.id) || 0)) + 1 : 1,
        firstName: firstName || '',
        lastName: lastName || '',
        email,
        phone: phone || '',
        password,
        createdAt: new Date().toISOString()
    };
    users.push(user);
    writeJson('users.json', users);
    res.status(201).json({ id: user.id, email: user.email });
});

app.post('/api/auth/login', (req, res) => {
    const users = readJson('users.json', []);
    const { email, password } = req.body || {};
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ token: `user_${Date.now()}`, name: `${user.firstName} ${user.lastName}`.trim() });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const admins = readJson('admins.json', []);
    const { username, password, code } = req.body || {};
    const ok = admins.find(a => a.username === username && a.password === password && a.code === code);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ token: `admin_${Date.now()}` });
});

// KYC submission (stores minimal info and uploaded files)
app.post('/api/kyc', upload.fields([
    { name: 'aadhaarFront', maxCount: 1 },
    { name: 'aadhaarBack', maxCount: 1 },
    { name: 'panPhoto', maxCount: 1 },
    { name: 'selfie', maxCount: 1 }
]), (req, res) => {
    const kycList = readJson('kyc.json', []);
    const { aadhaarNumber, fullName, panNumber } = req.body || {};
    const record = {
        id: kycList.length ? Math.max(...kycList.map(k => Number(k.id) || 0)) + 1 : 1,
        aadhaarNumber,
        fullName,
        panNumber,
        files: Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0]?.filename])),
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    kycList.push(record);
    writeJson('kyc.json', kycList);
    res.status(201).json({ success: true, status: 'pending' });
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

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

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


