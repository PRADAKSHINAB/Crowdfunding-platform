const mongoose = require('mongoose');

const DonationSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  donorName: {
    type: String,
    default: 'Anonymous'
  },
  donorEmail: {
    type: String,
    default: ''
  },
  donorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  razorpayOrderId: {
    type: String,
    required: true
  },
  razorpayPaymentId: {
    type: String
  },
  razorpaySignature: {
    type: String
  },
  status: {
    type: String,
    enum: ['pending', 'held', 'released', 'refunded'],
    default: 'pending'
  },
  statusTimeline: [
    {
      status: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
      updatedBy: { type: String, default: 'system' },
      note: { type: String, default: '' }
    }
  ],
  fraudFlagged: {
    type: Boolean,
    default: false
  },
  fraudCheckResult: {
    score: { type: Number, default: 0 },
    reasons: [String]
  },
  releaseApprovedBy: {
    type: String
  },
  releaseApprovedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexing for quick analytics and filtering
DonationSchema.index({ campaignId: 1, status: 1 });
DonationSchema.index({ donorEmail: 1 });

module.exports = mongoose.model('Donation', DonationSchema);
