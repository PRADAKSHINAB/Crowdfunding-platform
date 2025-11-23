const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String },
  fullName: { type: String },
  avatar: { type: String },
  role: { type: String, default: 'admin' },
  // store secrets (password/code) elsewhere; not returned by profile endpoint
  password: { type: String },
  code: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Admin', AdminSchema);
