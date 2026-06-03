const mongoose = require('mongoose');

/**
 * Session — tracks active login sessions per device.
 * Enables "logout all devices", "active session" view, and suspicious login detection.
 */
const SessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },

  // Device fingerprint
  device: {
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    // Parsed device info
    browser: { type: String, default: '' },
    os: { type: String, default: '' },
    deviceType: { type: String, enum: ['desktop', 'mobile', 'tablet', 'unknown'], default: 'unknown' }
  },

  // Geographic info (populated later by geo IP if available)
  geo: {
    country: { type: String, default: '' },
    city: { type: String, default: '' }
  },

  // Unique device ID generated client-side
  deviceId: { type: String, default: '' },

  // Linked refresh token family ID
  tokenFamily: { type: String, index: true },

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  lastActivity: {
    type: Date,
    default: Date.now
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  expiresAt: {
    type: Date,
    required: true
  },

  terminatedAt: Date,
  terminatedReason: {
    type: String,
    enum: ['logout', 'expired', 'admin', 'security', 'password_change', null],
    default: null
  }
});

// TTL — auto-remove expired sessions from DB
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SessionSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model('Session', SessionSchema);
