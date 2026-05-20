# GreenFund Crowdfunding Platform

## Introduction

Crowdfunding is widely used today to support social causes, innovative ideas, and emergency needs. However, many online platforms face major issues such as **fake campaigns**, **unverified users**, and **lack of transparency**, which reduce donor trust.

This project solves these problems by providing a **secure, audited, and transparent crowdfunding platform** built with the following core principles:

- **Mandatory KYC verification** for all campaign creators.
- **Admin approval** required before any campaign goes live.
- **Authentic and verified campaign management**.
- **Enterprise-grade security controls** protecting user accounts and platform integrity.

---

## Features

### 👤 User Features
- User registration with email verification flow.
- Reset password flow for forgotten passwords.
- Create and manage campaigns.
- Upload documents (Aadhaar, PAN) & campaign images.
- Complete KYC verification.
- Donate to campaigns.
- Access personal dashboard & session management.

---

### 🛡️ Payment & Escrow Release System
- **Donation States**: Donations are tracked with a lifecycle: `pending` ➔ `held` ➔ `released` or `refunded`.
- **Admin approval APIs**: Funds are held securely in escrow upon payment verification. They are NOT released immediately.
- **Escrow release rule**: Funds can only move to "released" state if the campaign goal has been achieved and an Admin approves the release.
- **Refund handling**: Admin can reject/cancel campaigns and trigger platform-wide donation refund updates, changing held donations to `refunded`.
- **Payment Status Timeline**: Displays a detailed transaction status timeline for backers to verify their funds are held securely in escrow.
- **Fraud Prevention**: Dynamic checking on donations (e.g. flagging names/emails matching threat profiles, large anonymous donations, etc.).
- **Escrow Logs**: Complete ledger logs for holds, releases, and refunds.

---

### 🚀 Campaign Verification Workflow
- **Verification Request**: Creators can request a verified badge for their campaigns by submitting details and supplementary documents.
- **Verification States**: Requests are processed through `pending`, `approved`, or `rejected` states.
- **Admin Verification Dashboard**: Specialized admin review panel to inspect creator notes, KYC linkage, and approve/reject with review notes.
- **Verified Badge**: Verified campaigns display a glowing green badge in search pages and details.
- **Priority Search Ranking**: Verified campaigns automatically bubble up to the top of list filters and search queries.

---

### 📍 Location-Aware Discovery
- **Geographic Filters**: Filter campaigns by City, State, and Country.
- **GPS Coordinates**: Locate user coordinates in real-time.
- **GPS Search Radius**: Slider control allowing users to discover campaigns within a specific distance (10 km to 2000 km) using MongoDB geospatial lookups or mathematical distance calculation fallbacks.

---

### 🛠️ Admin Security Console
- **Analytics**: High-level platform funding and security metrics.
- **Audit Logs**: Chronological event logs filterable by severity & outcome.
- **Security Feed**: real-time threat detection events (brute force warnings, locked users).
- **Suspicious IP Analyzer**: Identifies IPs with repeated failed logins.
- **Active Session Manager**: Lists active login devices for a user with one-click remote session revocation.

---

### 🛡️ Security Features
- **Brute-Force Attack Prevention**: Automatic IP & account lockout after 5 consecutive failed login attempts (locks account for 24 hours).
- **Dual-Token Session Rotation**: Short-lived Access Tokens (15-min) and HTTP-only Cookie Refresh Tokens (7-day) with rotation and reuse attack detection (revokes all family tokens upon reuse).
- **Web Security Hardening**: Integrated security headers (`Helmet`), Parameter Pollution mitigation (`HPP`), rate limiters (`express-rate-limit`), and input verification.
- **Non-repudiable Audit Trail**: System-wide logs recording actions (`user.login_failed`, `kyc.submitted`, `admin.settings_change`, etc.) to MongoDB.

---

### ⚙️ System Features
- MongoDB as the primary database with Mongoose schemas.
- Automatic fallback to local JSON storage when MongoDB is unavailable.
- Razorpay payment integration.
- Automatic migration of JSON data → MongoDB on startup.
- Development email engine with local Ethereal Mail logging.

---

# 📁 Project Setup

## 1️⃣ Clone the Repository
```bash
git clone <your-repo-url>
cd crowdfunding-project
```

## 2️⃣ Backend Setup
Navigate to the root folder:
```bash
npm install
```

### 🔐 Environment Variables
Create a file named `.env` in the root directory.

#### Sample `.env`
```env
PORT=4000
CLIENT_ORIGIN=http://localhost:5500,http://127.0.0.1:5500
MONGODB_URI=your_mongodb_connection_string
RAZORPAY_KEY_ID=your_key
RAZORPAY_KEY_SECRET=your_secret
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_SECRET=your_refresh_secret
REFRESH_TOKEN_EXPIRES_IN=7d
```

### ▶️ Start Backend
```bash
npm run dev
```

---

## 3️⃣ Frontend Setup
Open the folder `crowdfunding/` using Live Server or any static web server:
- Right-click `index.html` inside VS Code and select "Open with Live Server".
- The default port will match `http://127.0.0.1:5500`.

---

# 🧩 Data Models

### 👤 User Model
- `username`: String
- `email`: String (unique)
- `password`: String (bcrypt hashed)
- `fullName`: String
- `profileImage`: String
- `isKYCVerified`: Boolean
- `status`: String (`"active" | "locked" | "suspended"`)
- `loginAttempts`: Number
- `lockUntil`: Date
- `isEmailVerified`: Boolean
- `emailVerificationToken`: String
- `passwordResetToken`: String

### 📢 Campaign Model
- `title`: String
- `description`: String
- `category`: String
- `goal`: Number
- `raised`: Number
- `backers`: Number
- `duration`: Number
- `location`: String
- `creatorId`: String
- `creatorName`: String
- `image`: String
- `status`: String (`"pending" | "approved" | "rejected"`)
- `city`: String
- `state`: String
- `country`: String
- `latitude`: Number
- `longitude`: Number
- `isVerified`: Boolean
- `verificationStatus`: String (`"none" | "pending" | "approved" | "rejected"`)
- `verificationNotes`: String

### 📝 KYC Model
- `userId`: String
- `fullName`: String
- `aadhaarNumber`: String (masked/plain)
- `panNumber`: String
- `files`: Object (`aadhaarFront`, `aadhaarBack`, `panPhoto`, `selfie`)
- `status`: String (`"pending" | "verified" | "rejected"`)

### 💰 Donation Model
- `campaignId`: String
- `amount`: Number
- `donorName`: String
- `donorEmail`: String
- `razorpayOrderId`: String
- `razorpayPaymentId`: String
- `status`: String (`"pending" | "held" | "released" | "refunded"`)
- `createdAt`: Date

### 🔑 RefreshToken Model
- `token`: String (unique hash)
- `userId`: String
- `family`: String (rotation identifier)
- `expiresAt`: Date (TTL index auto-expired)

### 💻 Session Model
- `userId`: String
- `tokenFamily`: String
- `ip`: String
- `userAgent`: String
- `expiresAt`: Date

### 📋 AuditLog Model
- `event`: String
- `actor`: Object (`userId`, `ip`, `userAgent`)
- `severity`: String (`"info" | "warning" | "critical"`)
- `outcome`: String (`"success" | "failure"`)
- `metadata`: Object
- `timestamp`: Date
