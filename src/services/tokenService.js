/**
 * tokenService.js — Enterprise-grade JWT lifecycle management
 * Handles: access tokens, refresh tokens, rotation, blacklisting, family revocation
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

// Lazy-load models to avoid circular dependency issues
let RefreshToken, BlacklistToken;
function getModels() {
  if (!RefreshToken) RefreshToken = require('../../models/RefreshToken');
  if (!BlacklistToken) BlacklistToken = require('../../models/BlacklistToken');
}

// ─── Config ───────────────────────────────────────────────────────────────────
const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me';

const ACCESS_TOKEN_EXPIRES = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_TOKEN_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_TOKEN_EXPIRES = process.env.ADMIN_JWT_EXPIRES_IN || '4h';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Hash a token string for safe storage (we never store raw refresh tokens) */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Extract IP from request with proxy awareness */
function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    ''
  );
}

/** Parse ms from string like '7d', '2h', '30m' */
function parseMs(str) {
  if (!str) return REFRESH_TOKEN_EXPIRES_MS;
  const n = parseInt(str);
  if (str.endsWith('d')) return n * 24 * 60 * 60 * 1000;
  if (str.endsWith('h')) return n * 60 * 60 * 1000;
  if (str.endsWith('m')) return n * 60 * 1000;
  return REFRESH_TOKEN_EXPIRES_MS;
}

// ─── Access Token ──────────────────────────────────────────────────────────────

/**
 * Sign a short-lived access token.
 * Includes jti (JWT ID) for blacklisting support.
 */
function signAccessToken(payload) {
  const jti = uuidv4();
  return {
    token: jwt.sign(
      { ...payload, jti, type: 'access' },
      ACCESS_TOKEN_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRES }
    ),
    jti
  };
}

/**
 * Verify an access token. Throws if invalid.
 * Also checks blacklist if Mongoose is available.
 */
async function verifyAccessToken(token) {
  const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
  if (decoded.type !== 'access') throw new Error('Invalid token type');

  // Check blacklist (best-effort — skip if DB unavailable)
  if (mongoose.connection.readyState === 1) {
    try {
      getModels();
      const blacklisted = await BlacklistToken.exists({ jti: decoded.jti });
      if (blacklisted) throw new Error('Token has been revoked');
    } catch (err) {
      if (err.message === 'Token has been revoked') throw err;
      // DB unavailable — allow (graceful degradation)
    }
  }
  return decoded;
}

/**
 * Blacklist an access token by its jti.
 */
async function blacklistAccessToken(jti, userId, exp, reason = 'logout') {
  if (mongoose.connection.readyState !== 1) return;
  try {
    getModels();
    const expiresAt = exp ? new Date(exp * 1000) : new Date(Date.now() + parseMs(ACCESS_TOKEN_EXPIRES));
    await BlacklistToken.create({ jti, userId: String(userId), reason, expiresAt });
  } catch (err) {
    // Duplicate key = already blacklisted; ignore
    if (err.code !== 11000) console.error('[TokenService] blacklist error:', err.message);
  }
}

// ─── Refresh Token ─────────────────────────────────────────────────────────────

/**
 * Generate & persist a refresh token for a user.
 * Returns { token, family } — token is the raw token to send as cookie.
 */
async function createRefreshToken(userId, req, family = null) {
  getModels();
  const rawToken = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashToken(rawToken);
  const tokenFamily = family || uuidv4(); // new family for new logins
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS);

  await RefreshToken.create({
    token: rawToken,
    tokenHash,
    userId,
    family: tokenFamily,
    deviceInfo: {
      userAgent: req.headers['user-agent'] || '',
      ip: getClientIP(req),
      deviceId: req.headers['x-device-id'] || ''
    },
    expiresAt
  });

  return { token: rawToken, family: tokenFamily, expiresAt };
}

/**
 * Validate a refresh token (rotation-aware with reuse detection).
 * Returns the DB record on success.
 * On reuse of a revoked token → revokes entire family (security response).
 */
async function consumeRefreshToken(rawToken) {
  getModels();
  const record = await RefreshToken.findOne({ token: rawToken }).lean();

  if (!record) throw new Error('Refresh token not found');

  if (record.isRevoked) {
    // SECURITY: Revoked token used — attacker may have stolen it.
    // Revoke the entire family to protect the legitimate user.
    await RefreshToken.revokeFamilyTokens(record.family, 'security');
    throw new Error('Refresh token reuse detected — all sessions revoked for security');
  }

  if (new Date() > record.expiresAt) {
    await RefreshToken.findByIdAndUpdate(record._id, { isRevoked: true, revokedReason: 'expired' });
    throw new Error('Refresh token expired');
  }

  // Rotate: revoke current, issue new one in same family
  await RefreshToken.findByIdAndUpdate(record._id, {
    isRevoked: true,
    revokedAt: new Date(),
    revokedReason: 'logout', // rotated — not a security event
    lastUsedAt: new Date(),
    $inc: { usageCount: 1 }
  });

  return record;
}

/**
 * Revoke all refresh tokens for a user (logout all devices).
 */
async function revokeAllUserTokens(userId, reason = 'logout') {
  getModels();
  return await RefreshToken.revokeAllForUser(userId, reason);
}

/**
 * Revoke a single refresh token family (logout this device).
 */
async function revokeFamilyTokens(family, reason = 'logout') {
  getModels();
  return await RefreshToken.revokeFamilyTokens(family, reason);
}

/**
 * Get all active refresh token sessions for a user (for "active sessions" view).
 */
async function getActiveUserSessions(userId) {
  getModels();
  return await RefreshToken.find({
    userId,
    isRevoked: false,
    expiresAt: { $gt: new Date() }
  }).lean();
}

// ─── Admin Token ───────────────────────────────────────────────────────────────

function signAdminToken(payload) {
  const jti = uuidv4();
  return {
    token: jwt.sign(
      { ...payload, role: 'admin', jti, type: 'admin_access' },
      ADMIN_JWT_SECRET,
      { expiresIn: ADMIN_TOKEN_EXPIRES }
    ),
    jti
  };
}

async function verifyAdminToken(token) {
  const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
  if (decoded.role !== 'admin') throw new Error('Not an admin token');

  // Check blacklist
  if (mongoose.connection.readyState === 1) {
    try {
      getModels();
      const blacklisted = await BlacklistToken.exists({ jti: decoded.jti });
      if (blacklisted) throw new Error('Token has been revoked');
    } catch (err) {
      if (err.message === 'Token has been revoked') throw err;
    }
  }
  return decoded;
}

// ─── Cookie helpers ────────────────────────────────────────────────────────────

/** Secure cookie options for refresh token */
function refreshCookieOptions(expiresAt) {
  return {
    httpOnly: true,                     // Not accessible to JS
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/api/auth',                  // Restrict to auth endpoints
    expires: expiresAt
  };
}

/** Clear the refresh cookie (logout) */
function clearRefreshCookie(res) {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/api/auth'
  });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  blacklistAccessToken,
  createRefreshToken,
  consumeRefreshToken,
  revokeAllUserTokens,
  revokeFamilyTokens,
  getActiveUserSessions,
  signAdminToken,
  verifyAdminToken,
  refreshCookieOptions,
  clearRefreshCookie,
  hashToken,
  getClientIP,
  ACCESS_TOKEN_EXPIRES,
  REFRESH_TOKEN_EXPIRES_MS
};
