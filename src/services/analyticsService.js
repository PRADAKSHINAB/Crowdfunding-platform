/**
 * analyticsService.js — Admin analytics and dashboard metrics
 * Aggregates real data for platform insights.
 */

const mongoose = require('mongoose');

// Lazy-load models
let AuditLog, User, Campaign, Session, RefreshToken;
function getModels() {
  if (!AuditLog) AuditLog = require('../../models/AuditLog');
  if (!User) User = require('../../models/User');
  if (!Campaign) Campaign = require('../../models/Campaign');
  if (!Session) Session = require('../../models/Session');
  if (!RefreshToken) RefreshToken = require('../../models/RefreshToken');
}

/** Returns basic platform stats for the admin dashboard overview */
async function getPlatformStats() {
  getModels();
  const now = new Date();
  const last24h = new Date(now - 24 * 60 * 60 * 1000);
  const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    newUsersToday,
    newUsers7d,
    totalCampaigns,
    activeCampaigns,
    pendingCampaigns,
    activeSessions,
    loginsToday,
    failedLoginsToday,
    criticalEvents24h
  ] = await Promise.allSettled([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: last24h } }),
    User.countDocuments({ createdAt: { $gte: last7d } }),
    Campaign.countDocuments(),
    Campaign.countDocuments({ status: 'approved' }),
    Campaign.countDocuments({ status: 'pending' }),
    RefreshToken.countDocuments({ isRevoked: false, expiresAt: { $gt: now } }),
    AuditLog.countDocuments({ event: 'user.login', timestamp: { $gte: last24h }, outcome: 'success' }),
    AuditLog.countDocuments({ event: 'user.login_failed', timestamp: { $gte: last24h } }),
    AuditLog.countDocuments({ severity: 'critical', timestamp: { $gte: last24h } })
  ]);

  const safe = (r) => r.status === 'fulfilled' ? r.value : 0;

  return {
    users: {
      total: safe(totalUsers),
      newToday: safe(newUsersToday),
      new7d: safe(newUsers7d)
    },
    campaigns: {
      total: safe(totalCampaigns),
      active: safe(activeCampaigns),
      pending: safe(pendingCampaigns)
    },
    sessions: {
      active: safe(activeSessions)
    },
    security: {
      loginsToday: safe(loginsToday),
      failedLoginsToday: safe(failedLoginsToday),
      criticalEvents24h: safe(criticalEvents24h)
    }
  };
}

/** Time-series login activity for the last N days */
async function getLoginActivity(days = 7) {
  getModels();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const results = await AuditLog.aggregate([
    {
      $match: {
        event: { $in: ['user.login', 'user.login_failed'] },
        timestamp: { $gte: since }
      }
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          outcome: '$outcome'
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.date': 1 } }
  ]);

  // Reshape for chart consumption
  const map = {};
  for (const r of results) {
    const d = r._id.date;
    if (!map[d]) map[d] = { date: d, successful: 0, failed: 0 };
    if (r._id.outcome === 'success') map[d].successful = r.count;
    else map[d].failed = r.count;
  }
  return Object.values(map);
}

/** Top events by frequency in the last N hours */
async function getTopEvents(hours = 24, limit = 10) {
  getModels();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  return await AuditLog.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $group: { _id: '$event', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]);
}

/** Recent critical/warning security events for admin feed */
async function getSecurityFeed(limit = 20) {
  getModels();
  return await AuditLog.find({
    severity: { $in: ['warning', 'critical'] }
  })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
}

/** Recent audit log entries with optional filter */
async function getAuditLogs({ page = 1, limit = 50, event, severity, userId, outcome } = {}) {
  getModels();
  const filter = {};
  if (event) filter.event = event;
  if (severity) filter.severity = severity;
  if (outcome) filter.outcome = outcome;
  if (userId) filter['actor.userId'] = userId;

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  return { logs, total, page, totalPages: Math.ceil(total / limit) };
}

/** Campaign funding analytics */
async function getCampaignAnalytics() {
  getModels();
  const results = await Campaign.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalGoal: { $sum: '$goal' },
        totalRaised: { $sum: '$raised' }
      }
    }
  ]);

  const topCampaigns = await Campaign.find({ status: 'approved' })
    .sort({ raised: -1 })
    .limit(5)
    .select('title raised goal backers category')
    .lean();

  return { byStatus: results, topCampaigns };
}

/** User growth over time */
async function getUserGrowth(days = 30) {
  getModels();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return await User.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);
}

/** IP-based suspicious activity detection */
async function getSuspiciousIPs(hours = 24, threshold = 10) {
  getModels();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  return await AuditLog.aggregate([
    {
      $match: {
        event: 'user.login_failed',
        timestamp: { $gte: since },
        'actor.ip': { $ne: '' }
      }
    },
    {
      $group: {
        _id: '$actor.ip',
        count: { $sum: 1 },
        lastAttempt: { $max: '$timestamp' }
      }
    },
    { $match: { count: { $gte: threshold } } },
    { $sort: { count: -1 } }
  ]);
}

module.exports = {
  getPlatformStats,
  getLoginActivity,
  getTopEvents,
  getSecurityFeed,
  getAuditLogs,
  getCampaignAnalytics,
  getUserGrowth,
  getSuspiciousIPs
};
