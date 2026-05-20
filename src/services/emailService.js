/**
 * emailService.js — Enterprise-grade email service for verification and recovery
 * Uses nodemailer with environment-configured SMTP, falling back to Ethereal/console.
 */

const nodemailer = require('nodemailer');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  const isProduction = process.env.NODE_ENV === 'production';
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (isProduction && smtpHost && smtpUser && smtpPass) {
    // Production SMTP
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // true for 465, false for other ports
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  } else {
    // Development fallback: Log emails to console or use a mock account
    console.log('[EMAIL] SMTP not fully configured. Using fallback console/mock mailer.');
    transporter = {
      sendMail: async (options) => {
        console.log('=== [MOCK EMAIL SENT] ===');
        console.log(`To:      ${options.to}`);
        console.log(`Subject: ${options.subject}`);
        console.log(`Body:    ${options.text || options.html}`);
        console.log('==========================');
        return { messageId: `mock_${Date.now()}` };
      }
    };
  }

  return transporter;
}

/**
 * Send email verification link
 */
async function sendVerificationEmail(email, token, origin) {
  const verifyUrl = `${origin}/verify-email.html?token=${token}`;
  const mailer = await getTransporter();

  const mailOptions = {
    from: process.env.SMTP_FROM || '"GreenFund Security" <security@greenfund.org>',
    to: email,
    subject: 'Verify Your GreenFund Account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #1a1a1a; background-color: #0d0d0d; color: #ffffff;">
        <h2 style="color: #00ff66; border-bottom: 2px solid #00ff66; padding-bottom: 10px;">Welcome to GreenFund!</h2>
        <p>Thank you for registering. To complete your account verification, please click the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyUrl}" style="background-color: #00ff66; color: #000000; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block;">Verify Account</a>
        </div>
        <p>If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #00ff66;">${verifyUrl}</p>
        <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
        <p style="font-size: 12px; color: #666;">This link will expire in 24 hours. If you did not sign up for this account, you can safely ignore this email.</p>
      </div>
    `,
    text: `Welcome to GreenFund!\n\nPlease verify your account by visiting the following link:\n${verifyUrl}\n\nThis link will expire in 24 hours.`
  };

  return await mailer.sendMail(mailOptions);
}

/**
 * Send password reset link
 */
async function sendPasswordResetEmail(email, token, origin) {
  const resetUrl = `${origin}/reset-password.html?token=${token}`;
  const mailer = await getTransporter();

  const mailOptions = {
    from: process.env.SMTP_FROM || '"GreenFund Security" <security@greenfund.org>',
    to: email,
    subject: 'GreenFund Password Reset Request',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #1a1a1a; background-color: #0d0d0d; color: #ffffff;">
        <h2 style="color: #00ff66; border-bottom: 2px solid #00ff66; padding-bottom: 10px;">Password Reset Request</h2>
        <p>We received a request to reset your password. Click the button below to choose a new one:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #00ff66; color: #000000; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block;">Reset Password</a>
        </div>
        <p>If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #00ff66;">${resetUrl}</p>
        <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
        <p style="font-size: 12px; color: #666;">This link will expire in 1 hour. If you did not request a password reset, please secure your account immediately.</p>
      </div>
    `,
    text: `GreenFund Password Reset Request\n\nPlease reset your password by visiting the following link:\n${resetUrl}\n\nThis link will expire in 1 hour.`
  };

  return await mailer.sendMail(mailOptions);
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail
};
