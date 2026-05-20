const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: String,
  goal: {
    type: Number,
    required: true
  },
  raised: {
    type: Number,
    default: 0
  },
  backers: {
    type: Number,
    default: 0
  },
  duration: Number,
  location: String, // Full text address or name
  
  // Geolocation fields
  city: String,
  state: String,
  country: String,
  locationGeo: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      index: '2dsphere' // Geospatial 2dsphere index
    }
  },

  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  creatorName: String,
  image: String,
  documents: [String],
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  
  // Campaign Verification Workflow fields
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none'
  },
  verificationNotes: {
    type: String,
    default: ''
  },
  verificationRequestedAt: {
    type: Date
  },
  verifiedAt: {
    type: Date
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for optimal queries and ranking
CampaignSchema.index({ isVerified: -1, createdAt: -1 });

module.exports = mongoose.model('Campaign', CampaignSchema);