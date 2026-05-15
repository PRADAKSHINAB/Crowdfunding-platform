const mongoose = require('mongoose');

const KYCSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  fullName: String,
  // Sensitive fields — stored AES-256-GCM encrypted (see src/security.js)
  aadhaarNumber: String,
  panNumber: String,
  // Safe masked version for display in admin UI (e.g. XXXX-XXXX-1234)
  maskedAadhaar: { type: String, default: '' },
  // Use String to support both numeric IDs (file store) and ObjectIds (Mongo)
  campaignId: String,
  files: {
    type: Object,
    default: {}
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'verified'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  verifiedAt: Date,
  rejectedAt: Date,
  reason: String
});

module.exports = mongoose.model('KYC', KYCSchema);