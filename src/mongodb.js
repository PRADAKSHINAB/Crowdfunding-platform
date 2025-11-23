const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Import models
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const KYC = require('../models/KYC');
const Admin = require('../models/Admin');

// Data directories
const DATA_DIR = path.join(__dirname, '..', 'data');

// Connect to MongoDB
const connectMongoDB = async () => {
  try {
    // Use MongoDB Atlas connection from .env file
    const mongoURI = process.env.MONGODB_URI;
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB Atlas connected successfully');
    return true;
  } catch (error) {
    console.log('MongoDB connection error:', error);
    return false;
  }
};

// Admin migration
const migrateAdmins = async () => {
  try {
    const adminsPath = path.join(DATA_DIR, 'admins.json');
    if (fs.existsSync(adminsPath)) {
      const admins = JSON.parse(fs.readFileSync(adminsPath, 'utf8')) || [];
      for (const a of admins) {
        const username = a.username || 'admin';
        const existing = await Admin.findOne({ username });
        if (!existing) {
          await Admin.create({
            username,
            fullName: a.fullName || 'Administrator',
            email: a.email || '',
            avatar: a.avatar || '',
            role: 'admin',
            // store password/code for backward compatibility if present
            password: a.password || '',
            code: a.code || ''
          });
        }
      }
      console.log('Admins migrated successfully');
    }
  } catch (error) {
    console.error('Error migrating admins:', error);
  }
};

// MongoDB CRUD operations
const mongoDb = {
  // User operations
  getUsers: async () => {
    return await User.find();
  },
  
  getUserById: async (id) => {
    return await User.findById(id);
  },
  
  getUserByUsername: async (username) => {
    return await User.findOne({ username });
  },
  
  getUserByEmail: async (email) => {
    return await User.findOne({ email });
  },
  
  createUser: async (userData) => {
    const user = new User(userData);
    return await user.save();
  },
  
  updateUser: async (id, userData) => {
    return await User.findByIdAndUpdate(id, userData, { new: true });
  },
  
  // Campaign operations
  getCampaigns: async () => {
    return await Campaign.find();
  },
  
  getCampaignById: async (id) => {
    return await Campaign.findById(id);
  },
  
  createCampaign: async (campaignData) => {
    const campaign = new Campaign(campaignData);
    return await campaign.save();
  },
  
  updateCampaign: async (id, campaignData) => {
    return await Campaign.findByIdAndUpdate(id, campaignData, { new: true });
  },
  
  // Increment campaign stats atomically
  incrementCampaignStats: async (id, amount) => {
    const inc = {
      $inc: {
        raised: Math.max(0, Number(amount) || 0),
        backers: 1
      }
    };
    return await Campaign.findByIdAndUpdate(id, inc, { new: true });
  },
  
  // KYC operations
  getKYCs: async () => {
    return await KYC.find();
  },
  
  getKYCByUserId: async (userId) => {
    return await KYC.findOne({ userId });
  },
  
  createKYC: async (kycData) => {
    const kyc = new KYC(kycData);
    return await kyc.save();
  },
  
  updateKYC: async (id, kycData) => {
    return await KYC.findByIdAndUpdate(id, kycData, { new: true });
  },
  
  // Delete multiple KYC records by their IDs
  deleteKYCsByIds: async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { deletedCount: 0 };
    const res = await KYC.deleteMany({ _id: { $in: ids } });
    return { deletedCount: res.deletedCount || 0 };
  },
  
  // Admin operations
  getAdmins: async () => {
    return await Admin.find();
  },
  
  getAdminByUsername: async (username) => {
    return await Admin.findOne({ username });
  },
  
  createAdmin: async (adminData) => {
    const admin = new Admin(adminData);
    return await admin.save();
  },
  
  updateAdmin: async (id, adminData) => {
    return await Admin.findByIdAndUpdate(id, adminData, { new: true });
  }
};

// Migration functions
const migrateUsers = async () => {
  try {
    const usersPath = path.join(DATA_DIR, 'users.json');
    if (fs.existsSync(usersPath)) {
      const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
      for (const user of users) {
        // Convert id to _id for MongoDB
        const userData = { ...user };
        delete userData.id;
        
        // Add default values for required fields if missing
        if (!userData.username) userData.username = userData.email ? userData.email.split('@')[0] : `user_${Date.now()}`;
        if (!userData.email) userData.email = `user_${Date.now()}@example.com`;
        if (!userData.password) userData.password = 'defaultpassword';
        
        // Check if user already exists
        const existingUser = await User.findOne({ email: userData.email });
        if (!existingUser) {
          try {
            await User.create(userData);
          } catch (err) {
            console.log(`Skipping user with email ${userData.email}: ${err.message}`);
          }
        }
      }
      console.log('Users migrated successfully');
    }
  } catch (error) {
    console.error('Error migrating users:', error);
  }
};

const migrateCampaigns = async () => {
  try {
    const campaignsPath = path.join(DATA_DIR, 'campaigns.json');
    if (fs.existsSync(campaignsPath)) {
      const campaigns = JSON.parse(fs.readFileSync(campaignsPath, 'utf8'));
      for (const campaign of campaigns) {
        // Convert id to _id for MongoDB
        const campaignData = { ...campaign };
        delete campaignData.id;
        
        // Add default values for required fields if missing
        if (!campaignData.title) campaignData.title = `Campaign_${Date.now()}`;
        if (!campaignData.description) campaignData.description = 'No description provided';
        if (!campaignData.userId) campaignData.userId = '507f1f77bcf86cd799439011'; // Valid ObjectId format
        if (!campaignData.creatorId) campaignData.creatorId = '507f1f77bcf86cd799439011'; // Valid ObjectId format
        if (!campaignData.goal) campaignData.goal = 1000;
        if (!campaignData.category) campaignData.category = 'Other';
        
        // Check if campaign already exists
        const existingCampaign = await Campaign.findOne({ title: campaignData.title });
        if (!existingCampaign) {
          try {
            await Campaign.create(campaignData);
          } catch (err) {
            console.log(`Skipping campaign ${campaignData.title}: ${err.message}`);
          }
        }
      }
      console.log('Campaigns migrated successfully');
    }
  } catch (error) {
    console.error('Error migrating campaigns:', error);
  }
};

const migrateKYCs = async () => {
  try {
    const kycsPath = path.join(DATA_DIR, 'kyc.json');
    if (fs.existsSync(kycsPath)) {
      const kycs = JSON.parse(fs.readFileSync(kycsPath, 'utf8'));
      for (const kyc of kycs) {
        // Convert id to _id for MongoDB
        const kycData = { ...kyc };
        delete kycData.id;
        
        // Normalize fields to the current schema
        // If legacy KYC has no userId, generate a unique ObjectId so multiple records don't collapse
        if (!kycData.userId) {
          kycData.userId = new mongoose.Types.ObjectId().toString();
        }
        if (!kycData.status) kycData.status = 'pending';
        // Ensure expected fields exist
        kycData.aadhaarNumber = kycData.aadhaarNumber || kycData.idNumber || '';
        kycData.panNumber = kycData.panNumber || '';
        kycData.files = kycData.files || {};
        // Normalize createdAt to Date
        if (kycData.createdAt) {
          try { kycData.createdAt = new Date(kycData.createdAt); } catch (_) {}
        }

        // Try to find existing by strongest keys first
        let existingKYC = null;
        if (kycData.aadhaarNumber && kycData.createdAt) {
          // Match by strong composite to avoid merging unrelated entries
          existingKYC = await KYC.findOne({
            aadhaarNumber: kycData.aadhaarNumber,
            campaignId: kycData.campaignId ?? { $exists: true },
            createdAt: kycData.createdAt
          });
        }

        try {
          if (existingKYC) {
            // Update missing/empty fields
            await KYC.updateOne({ _id: existingKYC._id }, {
              $set: {
                fullName: kycData.fullName || existingKYC.fullName,
                aadhaarNumber: kycData.aadhaarNumber || existingKYC.aadhaarNumber,
                panNumber: kycData.panNumber || existingKYC.panNumber,
                campaignId: typeof kycData.campaignId !== 'undefined' ? kycData.campaignId : existingKYC.campaignId,
                files: Object.keys(kycData.files || {}).length ? kycData.files : (existingKYC.files || {}),
                status: kycData.status || existingKYC.status,
                createdAt: kycData.createdAt ? new Date(kycData.createdAt) : existingKYC.createdAt
              }
            });
          } else {
            await KYC.create(kycData);
          }
        } catch (err) {
          console.log(`KYC migrate error for user ${kycData.userId}: ${err.message}`);
        }
      }
      console.log('KYCs migrated successfully');
    }
  } catch (error) {
    console.error('Error migrating KYCs:', error);
  }
};

const migrateData = async () => {
  await migrateUsers();
  await migrateCampaigns();
  await migrateKYCs();
  await migrateAdmins();
  console.log('All data migrated successfully');
};

module.exports = {
  connectMongoDB,
  mongoDb,
  migrateData
};