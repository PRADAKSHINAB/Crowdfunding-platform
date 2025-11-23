# 🎉 Razorpay Test Mode Integration Guide

## ✅ What's Been Implemented

Your GreenFund crowdfunding platform now has **real payment processing** using Razorpay's test/sandbox mode!

### Features Added:
- ✅ Razorpay SDK integration in backend
- ✅ Payment order creation endpoint
- ✅ Payment verification with signature validation
- ✅ Campaign detail page with donation form
- ✅ Razorpay checkout modal integration
- ✅ Secure payment flow (no fake donations possible)

---

## 🚀 How to Get Started

### Step 1: Get Razorpay Test Keys

1. **Sign up** at https://razorpay.com (free account)
2. Go to **Settings** → **API Keys**
3. Click **Generate Test Keys**
4. Copy your:
   - **Key ID** (starts with `rzp_test_`)
   - **Key Secret** (keep this private)

### Step 2: Update `.env` File

Open `backend/.env` and replace the placeholder keys:

```env
RAZORPAY_KEY_ID=rzp_test_YOUR_ACTUAL_KEY_HERE
RAZORPAY_KEY_SECRET=YOUR_ACTUAL_SECRET_HERE
```

### Step 3: Install Dependencies

```bash
cd backend
npm install razorpay
```

### Step 4: Start the Server

```bash
cd backend
npm start
```

Server will run at: `http://localhost:4000`

---

## 🧪 Testing Payments (Sandbox Mode)

### Test Card Details

Razorpay provides test cards that simulate successful/failed payments **WITHOUT charging real money**.

#### ✅ Successful Payment Test Cards:

| Card Number | CVV | Expiry | Result |
|-------------|-----|--------|--------|
| `4111 1111 1111 1111` | Any 3 digits | Any future date | Success |
| `5555 5555 5555 4444` | Any 3 digits | Any future date | Success |
| `3566 0020 2036 0505` | Any 3 digits | Any future date | Success |

#### ❌ Failed Payment Test Cards:

| Card Number | CVV | Expiry | Result |
|-------------|-----|--------|--------|
| `4000 0000 0000 0002` | Any 3 digits | Any future date | Card declined |
| `4000 0000 0000 0341` | Any 3 digits | Any future date | Insufficient funds |

#### 📱 Test UPI IDs:

- **Success**: `success@razorpay`
- **Failure**: `failure@razorpay`

#### 💳 Test Netbanking:

- Select any bank
- Use credentials: **Username**: `test`, **Password**: `test`

---

## 🎯 How to Test

### 1. Open the Application

Navigate to: `http://localhost:4000`

### 2. Browse Campaigns

- Click on **Campaigns** in the navigation
- Click on any campaign card

### 3. Make a Test Donation

1. Select a quick amount (₹500, ₹1000, ₹2000) or enter custom amount
2. Optionally enter your name and email
3. Click **"Donate Now"**
4. Razorpay checkout modal will open
5. Use test card: `4111 1111 1111 1111`
6. CVV: `123`
7. Expiry: Any future date (e.g., `12/25`)
8. Click **Pay**

### 4. Verify Success

- You'll see a success message
- Campaign's raised amount will update automatically
- Backers count will increase
- Check `backend/data/donations.json` to see the recorded donation with payment IDs

---

## 🔒 Security Features Implemented

### 1. **Signature Verification**
Every payment is verified using HMAC SHA256 signature to ensure it's genuine and not tampered with.

```javascript
// Backend verifies signature before saving donation
const expectedSign = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(order_id + '|' + payment_id)
    .digest('hex');
```

### 2. **No Direct Donations**
The old `/api/campaigns/:id/donations` endpoint now rejects requests. All donations must go through Razorpay.

### 3. **Amount Validation**
- Backend validates amount before creating order
- Prevents negative or zero amounts
- Converts rupees to paise correctly

### 4. **Payment Proof**
Each donation stores:
- `razorpayOrderId` - Order ID
- `razorpayPaymentId` - Payment ID (proof of payment)
- `status: 'completed'` - Only after verification

---

## 📊 Payment Flow Diagram

```
User                Frontend              Backend              Razorpay
  |                    |                     |                     |
  |--Click Donate----->|                     |                     |
  |                    |--Create Order------>|                     |
  |                    |                     |--Create Order------>|
  |                    |                     |<---Order ID---------|
  |                    |<--Order Details-----|                     |
  |<--Checkout Modal---|                     |                     |
  |                    |                     |                     |
  |--Enter Card------->|                     |                     |
  |--Pay-------------->|-------------------->|--Process Payment--->|
  |                    |                     |<---Payment Success--|
  |                    |--Verify Payment---->|                     |
  |                    |   (with signature)  |                     |
  |                    |                     |--Verify Signature-->|
  |                    |                     |--Save Donation----->|
  |                    |<--Success-----------|                     |
  |<--Thank You--------|                     |                     |
```

---

## 📁 Files Modified/Created

### Backend:
- ✅ `backend/src/server.js` - Added Razorpay endpoints
- ✅ `backend/.env` - Added Razorpay credentials
- ✅ `backend/package.json` - Will include `razorpay` after `npm install`

### Frontend:
- ✅ `crowdfunding/campaign-detail.html` - New page with donation form
- ✅ `crowdfunding/campaigns.html` - Updated to link to detail page

---

## 🐛 Troubleshooting

### Issue: "Failed to create payment order"

**Solution**: 
- Check if Razorpay keys are correctly set in `.env`
- Ensure backend server is running
- Check browser console for errors

### Issue: "Payment verification failed"

**Solution**:
- Make sure you're using the correct test card
- Check if `RAZORPAY_KEY_SECRET` is correct in `.env`
- Look at backend terminal logs for detailed error

### Issue: Checkout modal doesn't open

**Solution**:
- Ensure Razorpay script is loaded: `https://checkout.razorpay.com/v1/checkout.js`
- Check browser console for JavaScript errors
- Verify `RAZORPAY_KEY_ID` is correct

---

## 🎓 Understanding Test vs Live Mode

### Test Mode (Current Setup):
- ✅ Uses `rzp_test_` keys
- ✅ No real money involved
- ✅ Test cards work
- ✅ Perfect for development

### Live Mode (Production):
- ⚠️ Requires KYC verification
- ⚠️ Uses `rzp_live_` keys
- ⚠️ Real money transactions
- ⚠️ Only after thorough testing

**To switch to Live Mode:**
1. Complete KYC on Razorpay dashboard
2. Generate Live API keys
3. Replace `rzp_test_` keys with `rzp_live_` keys in `.env`
4. Test thoroughly before going live!

---

## 📞 Support

### Razorpay Documentation:
- https://razorpay.com/docs/payments/
- https://razorpay.com/docs/payment-gateway/test-card-details/

### Common Test Scenarios:

| Scenario | How to Test |
|----------|-------------|
| Successful payment | Use `4111 1111 1111 1111` |
| Failed payment | Use `4000 0000 0000 0002` |
| UPI success | Use `success@razorpay` |
| UPI failure | Use `failure@razorpay` |
| Cancel payment | Click "X" on checkout modal |

---

## ✨ Next Steps

1. **Get your Razorpay test keys** and update `.env`
2. **Install dependencies**: `npm install razorpay`
3. **Start the server**: `npm start`
4. **Test a donation** using test cards
5. **Check donations.json** to verify payment was recorded

---

## 🎉 Success Indicators

You'll know it's working when:
- ✅ Razorpay checkout modal opens
- ✅ Test payment succeeds
- ✅ Success message appears
- ✅ Campaign raised amount updates
- ✅ Donation appears in `backend/data/donations.json` with `razorpayPaymentId`

---

**Happy Testing! 🚀**

If you encounter any issues, check the browser console and backend terminal logs for detailed error messages.
