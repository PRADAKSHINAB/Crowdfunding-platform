const mongoose = require('mongoose');

const KYCSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  fullName: String,
  // Fields used in current application flows
  aadhaarNumber: String,
  panNumber: String,
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