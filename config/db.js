const mongoose = require('mongoose');

// MongoDB connection function
const connectDB = async () => {
  try {
    // MongoDB connection string - using localhost for development
    const conn = await mongoose.connect('mongodb://localhost:27017/crowdfunding', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return true;
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    // Fallback to file system if MongoDB connection fails
    console.log('Falling back to file system database');
    return false;
  }
};

module.exports = connectDB;