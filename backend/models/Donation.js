const mongoose = require('mongoose');

const DonationSchema = new mongoose.Schema({
  campaignId: {
    type: String,
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
  razorpayOrderId: {
    type: String,
    required: true
  },
  razorpayPaymentId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'held', 'released', 'refunded'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Donation', DonationSchema);
