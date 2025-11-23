# Crowdfunding Platform

## Introduction

Crowdfunding is widely used today to support social causes, innovative ideas, and emergency needs. However, many online platforms face major issues such as **fake campaigns**, **unverified users**, and **lack of transparency**, which reduce donor trust.

This project solves these problems by providing a **secure and transparent crowdfunding platform** built with the following principles:

- **Mandatory KYC verification** for all users  
- **Admin approval** required before any campaign goes live  
- **Authentic and verified campaign management**

Only verified users are allowed to create campaigns, and every campaign is reviewed manually by an admin. This improves **safety, authenticity, and overall trustworthiness** of the platform.

The goal is to offer a **reliable, user-friendly, and fraud-free crowdfunding environment** where donors can confidently support genuine and meaningful campaigns.

---

## Features

### 👤 User Features
- User registration & login  
- Create and manage campaigns  
- Upload documents & campaign images  
- Complete KYC verification  
- Donate to campaigns  
- Access personal dashboard  

---

### 🛠️ Admin Features
- Review and approve KYC applications  
- Approve or reject campaigns  
- Manage users, campaigns, and platform settings  
- View platform-level data  

---

### ⚙️ System Features
- MongoDB as the primary database  
- Automatic fallback to JSON storage when MongoDB is unavailable  
- Razorpay payment integration  
- Automatic migration of JSON data → MongoDB on first startup  

---

# 📁 Project Setup

## 1️⃣ Clone the Repository
```bash
git clone <your-repo-url>
cd crowdfunding-project

🖥️ Backend Setup
📂 Navigate to Backend
cd backend
📦 Install Dependencies
npm install
🔐 Environment Variables
Create a file named:
backend/.env
⚠️ This file is ignored by Git, so every developer must create it manually.

Sample .env

PORT=4000
CLIENT_ORIGIN=http://localhost:5500
MONGODB_URI=your_mongodb_connection_string
RAZORPAY_KEY_ID=your_key
RAZORPAY_KEY_SECRET=your_secret
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d

▶️ Start Backend
npm start

✔️ Startup Behavior
Connects to MongoDB

If MongoDB fails → Switches to JSON database automatically

Frontend Setup

Open the folder:
crowdfunding/
Run using Live Server:
Right-click index.html
Select "Open with Live Server"

🧩 Data Models

👤 User Model
username

email

password

fullName

profileImage

isKYCVerified

createdAt

📢 Campaign Model
title

description

category

goal

duration

location

creatorId

creatorName

image

documents

status

createdAt

📝 KYC Model
userId

fullName

idType

idNumber

idImage

addressProof

status

createdAt

💳Razorpay Integration
Add these inside .env:

RAZORPAY_KEY_ID=your_key
RAZORPAY_KEY_SECRET=your_secret