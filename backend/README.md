# Crowdfunding Platform - MongoDB Integration

## Overview
This project has been updated to use MongoDB as the primary database, with a fallback to the file system if MongoDB is unavailable.

## Setup Instructions

1. Install dependencies:
```
npm install
```

2. Configure MongoDB:
   - The application will connect to MongoDB using the connection string in the `.env` file
   - If MongoDB connection fails, it will automatically fall back to the file system database

3. Start the server:
```
npm start
```

## MongoDB Integration

- All data models (User, Campaign, KYC) have been migrated to MongoDB schemas
- API endpoints have been updated to work with both MongoDB and file system
- Existing data will be automatically migrated to MongoDB on first startup

## Environment Variables

- `PORT`: Server port (default: 4000)
- `CLIENT_ORIGIN`: CORS origin (default: *)
- `MONGODB_URI`: MongoDB connection string

## Data Models

1. User Schema
   - username, email, password, fullName, profileImage, isKYCVerified, createdAt

2. Campaign Schema
   - title, description, category, goal, duration, location, creatorId, creatorName, image, documents, status, createdAt

3. KYC Schema
   - userId, fullName, idType, idNumber, idImage, addressProof, status, createdAt