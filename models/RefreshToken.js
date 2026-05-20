const mongoose = require('mongoose');

const RefreshTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Hashed token for storage (we hash before saving)
  tokenHash: {
    type: String,
    index: true
  },
  // Device/browser fingerprint
  deviceInfo: {
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    deviceId: { type: String, default: '' }
  },
  isRevoked: {
    type: Boolean,
    default: false,
    index: true
  },
  revokedAt: Date,
  revokedReason: {
    type: String,
    enum: ['logout', 'password_change', 'security', 'admin', 'expired', null],
    default: null
  },
  // Family token chain (for rotation detection)
  family: {
    type: String,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUsedAt: Date,
  usageCount: {
    type: Number,
    default: 0
  }
});

// Auto-delete expired tokens (TTL index)
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Method: revoke this token
RefreshTokenSchema.methods.revoke = async function(reason = 'logout') {
  this.isRevoked = true;
  this.revokedAt = new Date();
  this.revokedReason = reason;
  return await this.save();
};

// Static: revoke all tokens for a user
RefreshTokenSchema.statics.revokeAllForUser = async function(userId, reason = 'security') {
  return await this.updateMany(
    { userId, isRevoked: false },
    { isRevoked: true, revokedAt: new Date(), revokedReason: reason }
  );
};

// Static: revoke all tokens in a family (reuse detection)
RefreshTokenSchema.statics.revokeFamilyTokens = async function(family, reason = 'security') {
  return await this.updateMany(
    { family, isRevoked: false },
    { isRevoked: true, revokedAt: new Date(), revokedReason: reason }
  );
};

module.exports = mongoose.model('RefreshToken', RefreshTokenSchema);
