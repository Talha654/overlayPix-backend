// import Stripe from 'stripe';
import { db } from './firebase.service.js';

import dotenv from 'dotenv';
dotenv.config();

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Generate QR code
export const generateEventQRCode = async (shareCode, eventName) => {
  try {
    const QRCode = await import('qrcode');
    const url = `${process.env.FRONTEND_URL}/termsAndPolicy/${shareCode}`;
    
    return await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (error) {
    console.error('QR Generation Error:', error);
    return '';
  }
};

// Process payment
export const processPayment = async ({ user, plan, payment }) => {
  // Stripe integration is temporarily disabled.
  return {
    id: 'stripe-disabled',
    amount: 0,
    status: 'skipped'
  };
};

const validateDiscount = async (code) => {
  // In a real app, validate against your database
  const discounts = {
    'WELCOME10': { percentOff: 10 },
    'SAVE20': { percentOff: 20 }
  };
  
  return discounts[code.toUpperCase()] || null;
};