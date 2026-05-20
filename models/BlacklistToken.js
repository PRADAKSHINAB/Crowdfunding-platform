const mongoose = require('mongoose');

/**
 * BlacklistToken — stores JTIs (JWT IDs) of revoked access tokens.
 * Access tokens are short-lived so the blacklist stays small.
 * TTL index auto-removes entries after the token would have expired anyway.
 */
const BlacklistTokenSchema = new mongoose.Schema({
  jti: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: String,
    index: true
  },
  reason: {
    type: String,
    enum: ['logout', 'password_change', 'security', 'admin'],
    default: 'logout'
  },
  expiresAt: {
    type: Date,
    required: true
  },
  revokedAt: {
    type: Date,
    default: Date.now
  }
});

// Auto-remove once token expires naturally
BlacklistTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('BlacklistToken', BlacklistTokenSchema);
