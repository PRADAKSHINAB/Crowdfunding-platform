/**
 * auditService.js — Centralized audit/event logging
 * All security and business events are recorded here.
 * Falls back to console if MongoDB unavailable.
 */

let AuditLog;
function getModel() {
  if (!AuditLog) AuditLog = require('../models/AuditLog');
  return AuditLog;
}

/**
 * Core logger. Fire-and-forget — never awaited by callers to avoid blocking.
 * @param {object} options
 */
async function log({
  event,
  actor = {},
  resource = {},
  outcome = 'success',
  metadata = {},
  severity = 'info'
}) {
  const entry = {
    event,
    actor: {
      userId: actor.userId || actor.id || null,
      username: actor.username || actor.email || 'anonymous',
      role: actor.role || 'anonymous',
      ip: actor.ip || '',
      userAgent: actor.userAgent || ''
    },
    resource: {
      type: resource.type || '',
      id: resource.id ? String(resource.id) : ''
    },
    outcome,
    metadata,
    severity,
    timestamp: new Date()
  };

  // Console always (structured JSON for log aggregators)
  const logLevel = severity === 'critical' ? 'error' : severity === 'warning' ? 'warn' : 'info';
  console[logLevel](`[AUDIT] ${event} | ${entry.actor.username} | ${outcome}`, {
    ip: entry.actor.ip,
    resource: entry.resource
  });

  // MongoDB persistence (best-effort)
  try {
    const Model = getModel();
    await Model.create(entry);
  } catch (err) {
    // Non-fatal — log to console only if DB unavailable
    console.warn('[AuditService] DB write failed:', err.message);
  }
}

// ─── Named event helpers ───────────────────────────────────────────────────────

function actorFromReq(req, user = null) {
  const u = user || req.user || {};
  return {
    userId: u.id || u._id || null,
    username: u.email || u.username || 'anonymous',
    role: u.role || (req.admin ? 'admin' : 'anonymous'),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '',
    userAgent: req.headers['user-agent'] || ''
  };
}

const audit = {
  /** User auth events */
  userRegister: (req, user) => log({
    event: 'user.register',
    actor: actorFromReq(req, user),
    resource: { type: 'user', id: user?._id || user?.id },
    outcome: 'success'
  }),

  userLogin: (req, user) => log({
    event: 'user.login',
    actor: actorFromReq(req, user),
    resource: { type: 'user', id: user?._id || user?.id },
    outcome: 'success'
  }),

  userLoginFailed: (req, email) => log({
    event: 'user.login_failed',
    actor: actorFromReq(req, { email }),
    outcome: 'failure',
    severity: 'warning',
    metadata: { email }
  }),

  userLogout: (req, user) => log({
    event: 'user.logout',
    actor: actorFromReq(req, user),
    resource: { type: 'user', id: user?.id },
    outcome: 'success'
  }),

  tokenRefresh: (req, userId) => log({
    event: 'user.token_refresh',
    actor: { ...actorFromReq(req), userId },
    outcome: 'success'
  }),

  tokenReuse: (req, userId) => log({
    event: 'security.token_reuse',
    actor: { ...actorFromReq(req), userId },
    outcome: 'blocked',
    severity: 'critical',
    metadata: { message: 'Refresh token reuse detected — all sessions revoked' }
  }),

  passwordChange: (req, user) => log({
    event: 'user.password_change',
    actor: actorFromReq(req, user),
    resource: { type: 'user', id: user?.id },
    outcome: 'success',
    severity: 'warning'
  }),

  passwordResetRequest: (req, email) => log({
    event: 'user.password_reset_request',
    actor: actorFromReq(req, { email }),
    metadata: { email },
    outcome: 'success'
  }),

  passwordReset: (req, userId) => log({
    event: 'user.password_reset',
    actor: { ...actorFromReq(req), userId },
    resource: { type: 'user', id: userId },
    outcome: 'success',
    severity: 'warning'
  }),

  /** Admin events */
  adminLogin: (req, admin) => log({
    event: 'admin.login',
    actor: { ...actorFromReq(req), username: admin?.username, role: 'admin' },
    outcome: 'success',
    severity: 'warning'
  }),

  adminLoginFailed: (req, username) => log({
    event: 'admin.login_failed',
    actor: { ...actorFromReq(req), username },
    outcome: 'failure',
    severity: 'critical',
    metadata: { username }
  }),

  adminKYCAction: (req, kycId, action) => log({
    event: action === 'verified' ? 'admin.kyc_approve' : 'admin.kyc_reject',
    actor: { ...actorFromReq(req), role: 'admin' },
    resource: { type: 'kyc', id: kycId },
    outcome: 'success',
    severity: 'warning'
  }),

  adminCampaignAction: (req, campaignId, action) => log({
    event: action === 'approved' ? 'admin.campaign_approve' : 'admin.campaign_reject',
    actor: { ...actorFromReq(req), role: 'admin' },
    resource: { type: 'campaign', id: campaignId },
    outcome: 'success'
  }),

  /** KYC events */
  kycSubmit: (req, kycId, userId) => log({
    event: 'kyc.submit',
    actor: actorFromReq(req, req.user),
    resource: { type: 'kyc', id: kycId },
    metadata: { userId },
    outcome: 'success'
  }),

  /** Campaign events */
  campaignCreate: (req, campaignId) => log({
    event: 'campaign.create',
    actor: actorFromReq(req, req.user),
    resource: { type: 'campaign', id: campaignId },
    outcome: 'success'
  }),

  /** Payment events */
  paymentOrderCreate: (req, campaignId, amount) => log({
    event: 'payment.order_create',
    actor: actorFromReq(req, req.user),
    resource: { type: 'campaign', id: campaignId },
    metadata: { amount },
    outcome: 'success'
  }),

  paymentVerify: (req, campaignId, paymentId, amount) => log({
    event: 'payment.verify',
    actor: actorFromReq(req, req.user),
    resource: { type: 'campaign', id: campaignId },
    metadata: { paymentId, amount },
    outcome: 'success'
  }),

  paymentFailed: (req, campaignId, reason) => log({
    event: 'payment.failed',
    actor: actorFromReq(req, req.user),
    resource: { type: 'campaign', id: campaignId },
    metadata: { reason },
    outcome: 'failure',
    severity: 'warning'
  }),

  /** Security events */
  suspiciousActivity: (req, reason, metadata = {}) => log({
    event: 'security.suspicious_activity',
    actor: actorFromReq(req, req.user),
    outcome: 'blocked',
    severity: 'critical',
    metadata: { reason, ...metadata }
  }),

  rateLimitHit: (req, endpoint) => log({
    event: 'security.rate_limit_hit',
    actor: actorFromReq(req),
    metadata: { endpoint },
    outcome: 'blocked',
    severity: 'warning'
  }),

  /** Raw log for custom events */
  raw: log
};

module.exports = audit;
