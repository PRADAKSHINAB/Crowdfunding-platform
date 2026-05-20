/**
 * security.js — Centralised security middleware & helpers
 * Handles: rate limiting, input sanitisation, file validation,
 *          Aadhaar encryption, secure admin auth, and request hardening.
 */

const rateLimit = require('express-rate-limit');
const { body, param, query, validationResult } = require('express-validator');
const crypto = require('crypto');
const path = require('path');

const tokenService = require('./services/tokenService');
const auditService = require('./services/auditService');

// ─────────────────────────────────────────────
// 1. RATE LIMITERS
// ─────────────────────────────────────────────

/** Strict limiter for auth endpoints (login / register) */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,                      // 10 attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again after 15 minutes.' },
    skipSuccessfulRequests: true  // Only count failures
});

/** Payment endpoint limiter */
const paymentLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,   // 10 minutes
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many payment requests. Please wait 10 minutes.' }
});

/** KYC submission limiter (Aadhaar/PAN sensitive) */
const kycLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,   // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many KYC submissions. Please wait 1 hour.' }
});

/** General API limiter */
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests from this IP. Please slow down.' }
});

// ─────────────────────────────────────────────
// 2. INPUT VALIDATION CHAINS
// ─────────────────────────────────────────────

const validateRegister = [
    body('email')
        .isEmail().withMessage('Invalid email address')
        .normalizeEmail()
        .isLength({ max: 254 }).withMessage('Email too long'),
    body('password')
        .isLength({ min: 8, max: 128 }).withMessage('Password must be 8–128 characters')
        .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
        .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
        .matches(/[0-9]/).withMessage('Password must contain at least one number'),
    body('firstName')
        .optional()
        .trim()
        .isLength({ max: 50 }).withMessage('First name too long')
        .matches(/^[a-zA-Z\s'-]+$/).withMessage('First name contains invalid characters'),
    body('lastName')
        .optional()
        .trim()
        .isLength({ max: 50 }).withMessage('Last name too long')
        .matches(/^[a-zA-Z\s'-]+$/).withMessage('Last name contains invalid characters'),
    body('phone')
        .optional()
        .trim()
        .matches(/^[\d\s\-\+\(\)]{7,20}$/).withMessage('Invalid phone number')
];

const validateLogin = [
    body('email')
        .isEmail().withMessage('Invalid email address')
        .normalizeEmail(),
    body('password')
        .notEmpty().withMessage('Password is required')
        .isLength({ max: 128 }).withMessage('Password too long')
];

const validateAdminLogin = [
    body('username')
        .trim()
        .notEmpty().withMessage('Username is required')
        .isLength({ max: 50 }).withMessage('Username too long')
        .matches(/^[a-zA-Z0-9_\-]+$/).withMessage('Username contains invalid characters'),
    body('password')
        .notEmpty().withMessage('Password is required')
        .isLength({ max: 128 }),
    body('code')
        .notEmpty().withMessage('Admin code is required')
        .isLength({ max: 50 })
];

const validateKYC = [
    body('aadhaarNumber')
        .notEmpty().withMessage('Aadhaar number is required')
        .matches(/^\d{12}$/).withMessage('Aadhaar must be exactly 12 digits'),
    body('panNumber')
        .optional()
        .trim()
        .toUpperCase()
        .matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).withMessage('Invalid PAN format (e.g. ABCDE1234F)'),
    body('fullName')
        .trim()
        .notEmpty().withMessage('Full name is required')
        .isLength({ max: 100 })
        .matches(/^[a-zA-Z\s'-]+$/).withMessage('Full name contains invalid characters')
];

const validateCampaignId = [
    param('id')
        .notEmpty().withMessage('Campaign ID is required')
        .isLength({ max: 100 })
];

const validateContactForm = [
    body('email')
        .isEmail().withMessage('Invalid email address')
        .normalizeEmail(),
    body('firstName').trim().notEmpty().isLength({ max: 50 }),
    body('lastName').trim().optional().isLength({ max: 50 }),
    body('subject').trim().notEmpty().isLength({ max: 200 }),
    body('message').trim().notEmpty().isLength({ max: 2000 })
];

// ─────────────────────────────────────────────
// 3. VALIDATION RESULT HANDLER (middleware)
// ─────────────────────────────────────────────
function handleValidationErrors(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            message: 'Validation failed',
            errors: errors.array().map(e => ({ field: e.path, message: e.msg }))
        });
    }
    next();
}

// ─────────────────────────────────────────────
// 4. FILE UPLOAD SECURITY FILTER
// ─────────────────────────────────────────────

/** Allowed MIME types for KYC documents */
const ALLOWED_KYC_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
]);

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per file

/**
 * Multer file-filter for KYC uploads.
 * Rejects anything that isn't an image/PDF and files > 5 MB.
 */
function kycFileFilter(req, file, cb) {
    if (!ALLOWED_KYC_MIME.has(file.mimetype)) {
        return cb(new Error('Only JPEG, PNG, WEBP, or PDF files are allowed for KYC documents.'), false);
    }
    // Prevent path traversal via filename
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    file.originalname = safeName;
    cb(null, true);
}

// ─────────────────────────────────────────────
// 5. AADHAAR / PAN ENCRYPTION (AES-256-GCM)
// ─────────────────────────────────────────────

const ENCRYPTION_KEY_HEX = process.env.FIELD_ENCRYPTION_KEY || '';

function getEncryptionKey() {
    if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length < 64) {
        throw new Error('FIELD_ENCRYPTION_KEY env variable must be a 64-char hex string (32 bytes).');
    }
    return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a compact base64-encoded string: iv:authTag:ciphertext
 */
function encryptSensitiveField(plaintext) {
    if (!plaintext) return '';
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);                    // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypts a value produced by encryptSensitiveField.
 */
function decryptSensitiveField(ciphertext) {
    if (!ciphertext || !ciphertext.includes(':')) return ciphertext;
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encryptedData = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
}

/**
 * Masks Aadhaar for display/logging: shows only last 4 digits (XXXX-XXXX-1234)
 */
function maskAadhaar(aadhaar) {
    const s = String(aadhaar || '').replace(/\D/g, '');
    if (s.length !== 12) return 'XXXX-XXXX-XXXX';
    return `XXXX-XXXX-${s.slice(-4)}`;
}

// ─────────────────────────────────────────────
// 6. JWT MIDDLEWARE & AUTHORIZATION
// ─────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const User = require('../models/User');

function getAdminJwtSecret() {
    return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me';
}

/**
 * Signs a proper admin JWT.
 */
function signAdminToken(payload) {
    const { token } = tokenService.signAdminToken(payload);
    return token;
}

/**
 * Middleware: verifies that the request carries a valid user JWT.
 */
async function requireAuth(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const parts = auth.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({ message: 'Authorization header missing or invalid' });
        }
        const token = parts[1];
        const decoded = await tokenService.verifyAccessToken(token);
        
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: err.message || 'Invalid or expired token' });
    }
}

/**
 * Middleware: verifies that the request carries a valid admin JWT.
 */
async function requireAdminAuth(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const parts = auth.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({ message: 'Admin authorisation required' });
        }
        const token = parts[1];
        const decoded = await tokenService.verifyAdminToken(token);
        
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: err.message || 'Invalid or expired admin token' });
    }
}

/**
 * Middleware: Checks if user has a specific role.
 */
function checkRole(roles = []) {
    return (req, res, next) => {
        const role = req.user?.role || req.admin?.role || 'user';
        if (!roles.includes(role)) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges' });
        }
        next();
    };
}

/**
 * Middleware: Checks if account is locked or suspended in DB.
 */
async function checkAccountStatus(req, res, next) {
    if (!req.user || !req.user.id) return next();
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (user.status === 'suspended') {
            return res.status(403).json({ message: 'Account is suspended. Please contact support.' });
        }
        if (user.status === 'locked') {
            if (user.lockUntil && user.lockUntil > new Date()) {
                return res.status(403).json({ 
                    message: `Account is temporarily locked. Try again after ${user.lockUntil.toLocaleTimeString()}` 
                });
            } else {
                // Lock expired, reset attempts
                user.status = 'active';
                user.loginAttempts = 0;
                user.lockUntil = undefined;
                await user.save();
            }
        }
        next();
    } catch (err) {
        console.error('Account status check error:', err);
        res.status(500).json({ message: 'Internal security validation failed' });
    }
}

// ─────────────────────────────────────────────
// 7. SANITISE STRINGS (XSS-safe strip)
// ─────────────────────────────────────────────

/**
 * Strips HTML tags from a string to prevent stored XSS.
 */
function sanitiseString(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/<[^>]*>/g, '')      // remove HTML tags
        .replace(/[<>"'`]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '`': '&#x60;' }[c]))
        .trim();
}

// ─────────────────────────────────────────────
// 8. SECURITY HEADERS HELPER
// ─────────────────────────────────────────────

/**
 * Returns Helmet configuration tailored for this API + frontend mix.
 */
function helmetOptions() {
    return {
        contentSecurityPolicy: false,  // Managed separately; frontend is served too
        crossOriginEmbedderPolicy: false
    };
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
    // Rate limiters
    authLimiter,
    paymentLimiter,
    kycLimiter,
    generalLimiter,

    // Validators
    validateRegister,
    validateLogin,
    validateAdminLogin,
    validateKYC,
    validateCampaignId,
    validateContactForm,
    handleValidationErrors,

    // File upload
    kycFileFilter,
    MAX_FILE_SIZE_BYTES,

    // Encryption
    encryptSensitiveField,
    decryptSensitiveField,
    maskAadhaar,

    // Admin auth
    signAdminToken,
    requireAdminAuth,
    requireAuth,
    checkRole,
    checkAccountStatus,

    // Sanitisation
    sanitiseString,

    // Helmet config
    helmetOptions
};
