const mongoose = require('mongoose');

/**
 * AuditLog — immutable event record for every security-relevant action.
 * Never updated; only inserted. Indexed for fast admin queries.
 */
const AuditLogSchema = new mongoose.Schema({
  // Who did it
  actor: {
    userId: { type: String, default: null },   // user _id or null for anon
    username: { type: String, default: 'anonymous' },
    role: { type: String, enum: ['user', 'admin', 'system', 'anonymous'], default: 'anonymous' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' }
  },

  // What happened
  event: {
    type: String,
    required: true,
    index: true,
    // Standard event names
    enum: [
      // Auth
      'user.register', 'user.login', 'user.logout', 'user.login_failed',
      'user.token_refresh', 'user.token_revoked', 'user.password_change',
      'user.password_reset_request', 'user.password_reset',
      'user.email_verify', 'user.account_locked', 'user.account_unlocked',
      // Admin
      'admin.login', 'admin.login_failed', 'admin.logout',
      'admin.kyc_approve', 'admin.kyc_reject',
      'admin.campaign_approve', 'admin.campaign_reject',
      'admin.user_view', 'admin.settings_change',
      // KYC
      'kyc.submit', 'kyc.status_change',
      // Campaign
      'campaign.create', 'campaign.update', 'campaign.status_change',
      // Payment
      'payment.order_create', 'payment.verify', 'payment.failed',
      // Security
      'security.suspicious_activity', 'security.rate_limit_hit',
      'security.token_reuse', 'security.brute_force',
      // Session
      'session.create', 'session.revoke', 'session.expire',
      // System
      'system.startup', 'system.error'
    ]
  },

  // Resource that was affected
  resource: {
    type: { type: String, default: '' },   // 'campaign', 'user', 'kyc', etc.
    id: { type: String, default: '' }
  },

  // Outcome
  outcome: {
    type: String,
    enum: ['success', 'failure', 'blocked'],
    default: 'success'
  },

  // Extra contextual data (keep small — no PII)
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Severity for filtering
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info',
    index: true
  },

  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  // Disable Mongoose's __v and strict to allow .lean() optimization
  versionKey: false
});

// Compound index for admin dashboard queries
AuditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
AuditLogSchema.index({ event: 1, timestamp: -1 });
AuditLogSchema.index({ severity: 1, timestamp: -1 });
AuditLogSchema.index({ outcome: 1, timestamp: -1 });

// Auto-purge logs older than 90 days
AuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
