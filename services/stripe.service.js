import Stripe from 'stripe';
import { db } from './firebase.service.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Ensure Stripe secret key is properly configured
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16' // Use latest stable API version
});

/**
 * Validate and format email address for Stripe
 * @param {string} email - Email address to validate
 * @returns {string|null} - Formatted email or null if invalid
 */
function validateAndFormatEmail(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }
  
  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return null;
  }
  
  // Normalize email (lowercase, trim)
  return email.toLowerCase().trim();
}

/**
 * Server-side price calculation based on plan and customPlan
 * This prevents client-side price tampering
 */
function computeAmountFromPlan(plan, customPlan) {
  if (!plan || !customPlan) {
    throw new Error('Plan and customPlan are required for price calculation');
  }

  // Base price from the plan
  const basePrice = plan.price || 0;
  
  // Calculate additional costs for exceeding base limits
  const guestLimitIncrease = Math.max(0, customPlan.guestLimit - plan.guestLimit);
  const photoPoolIncrease = Math.max(0, customPlan.photoPool - plan.photoPool);
  
  const guestIncreaseCost = guestLimitIncrease * (plan.guestLimitIncreasePricePerGuest || 0);
  const photoPoolIncreaseCost = photoPoolIncrease * (plan.photoPoolLimitIncreasePricePerPhoto || 0);
  
  // Calculate storage cost
  const selectedStorageOption = plan.storageOptions?.find(opt => opt.days === customPlan.storageDays);
  const storageCost = selectedStorageOption?.price || 0;
  
  const totalAmount = basePrice + guestIncreaseCost + photoPoolIncreaseCost + storageCost;
  
  // Return amount in cents
  return Math.round(totalAmount * 100);
}

/**
 * Create a secure payment intent with server-side price validation
 * @param {string} userId - Authenticated user ID (must match req.user.uid)
 * @param {string} planId - Pricing plan ID
 * @param {Object} customPlan - Custom plan configuration
 * @param {number} clientFinalPrice - Client-calculated price (for validation)
 * @param {string} discountCode - Optional discount code
 * @param {string} userEmail - User's email for Stripe
 * @param {Object} userData - Additional user data (name, etc.)
 */
export const createPaymentIntent = async (userId, planId, customPlan, clientFinalPrice, discountCode = null, userEmail = null, userData = {}, paymentMethodType = null) => {
  // IMPORTANT: caller must have already authenticated userId === req.user.uid
  try {
    // 1) Fetch plan and compute server-side price
    const planDoc = await db.collection('pricingPlans').doc(planId).get();
    if (!planDoc.exists) {
      throw new Error('Invalid planId');
    }
    const plan = planDoc.data();

    // Compute server-side price in cents
    const serverCalculatedCents = computeAmountFromPlan(plan, customPlan);

    // 2) Calculate original price and validate client price
    let amountCents = serverCalculatedCents;
    let originalAmountCents = serverCalculatedCents;
    
    // Note: We'll validate the client price after applying discount
    // because the client should send the discounted price

    let discountAmountCents = 0;

    // 3) Handle discount code with new validation mechanism
    if (discountCode) {
      try {
        // Import the discount code service
        const { validateDiscountCode } = await import('./discountcode.service.js');
        
        // Validate the discount code
        const validationResult = await validateDiscountCode(discountCode);
        
        if (!validationResult.isValid) {
          throw new Error(`Invalid discount code: ${validationResult.error}`);
        }
        
        const discountCodeData = validationResult.discountCode;
        
        // Calculate discount amount based on type
        if (discountCodeData.discountType === 'percentage') {
          discountAmountCents = Math.round(amountCents * (discountCodeData.discountValue / 100));
        } else if (discountCodeData.discountType === 'fixed') {
          discountAmountCents = Math.round(discountCodeData.discountValue * 100);
        }
        
        // Ensure discount doesn't exceed the total amount
        discountAmountCents = Math.min(discountAmountCents, amountCents);
        
        // Apply discount
        amountCents -= discountAmountCents;
        
        console.log('Discount applied in payment intent:', {
          code: discountCode,
          type: discountCodeData.discountType,
          value: discountCodeData.discountValue,
          discountAmountCents,
          originalAmountCents: serverCalculatedCents,
          finalAmountCents: amountCents
        });
        
      } catch (discountError) {
        console.error('Discount code validation error in payment intent:', discountError);
        throw new Error(`Discount code validation failed: ${discountError.message}`);
      }
    }

    // 3.1) Validate client price against final calculated price (with discount applied)
    if (typeof clientFinalPrice === 'number') {
      const clientCents = Math.round(clientFinalPrice * 100);
      
      // If no discount code provided, accept client's price as final price
      if (!discountCode) {
        console.log('No discount code provided, using client price as final price:', {
          userId,
          planId,
          clientCents,
          serverCalculatedCents,
          originalPrice: serverCalculatedCents / 100,
          clientPrice: clientFinalPrice
        });
        amountCents = clientCents; // Use client's price
      } else if (clientCents !== amountCents) {
        // If discount code provided, validate the calculated price
        console.warn('Client finalPrice mismatch detected in payment intent', { 
          userId, 
          planId, 
          clientCents, 
          serverCalculatedCents,
          amountCents,
          discountAmountCents,
          discountCode,
          customPlan 
        });
        throw new Error('Price validation failed - client and server prices do not match');
      }
    }

    // 4) Enforce minimum charge (50 cents)
    if (amountCents > 0 && amountCents < 50) {
      amountCents = 50;
    }

    // 5) Handle free plans
    if (amountCents <= 0) {
      const mockPaymentId = `free_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      await db.collection('payments').doc(mockPaymentId).set({
        userId,
        planId,
        customPlan,
        finalPrice: 0,
        totalAmount: 0,
        originalPrice: originalAmountCents / 100,
        discountCode: discountCode || null,
        discountAmount: discountAmountCents / 100,
        status: 'succeeded',
        isFreePlan: true,
        createdAt: new Date(),
        userEmail,
        userData
      });

      return {
        clientSecret: null,
        paymentIntentId: mockPaymentId,
        amount: 0,
        currency: 'usd',
        isFreePlan: true
      };
    }

    // 6) Validate and format email, then create or retrieve Stripe customer
    let stripeCustomerId = null;
    const validatedEmail = validateAndFormatEmail(userEmail);
    
    if (validatedEmail) {
      try {
        // Check if customer already exists
        const customers = await stripe.customers.list({
          email: validatedEmail,
          limit: 1
        });

        if (customers.data.length > 0) {
          stripeCustomerId = customers.data[0].id;
          // Update customer with latest info
          await stripe.customers.update(stripeCustomerId, {
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              lastPayment: new Date().toISOString()
            }
          });
        } else {
          // Create new customer
          const customer = await stripe.customers.create({
            email: validatedEmail,
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              createdAt: new Date().toISOString()
            }
          });
          stripeCustomerId = customer.id;
        }
      } catch (customerError) {
        console.warn('Failed to create/update Stripe customer:', customerError);
        // Continue without customer - payment will still work
      }
    }

    // 7) Create idempotency key for safe retries
    // const idempotencyKey = `pi_${userId}_${planId}_${crypto.createHash('sha256')
    //   .update(JSON.stringify({ customPlan, discountCode }))
    //   .digest('hex')
    //   .substring(0, 16)}`;

    // 8) Create PaymentIntent with enhanced email handling and payment method support
    const paymentIntentData = {
      amount: amountCents,
      currency: 'usd',
      metadata: {
        userId,
        planId,
        discountCode: discountCode || '',
        isFreePlan: 'false',
        guestLimit: customPlan.guestLimit?.toString() || '',
        photoPool: customPlan.photoPool?.toString() || '',
        storageDays: customPlan.storageDays?.toString() || ''
      }
    };

    // Handle specific payment method types
    if (paymentMethodType === 'cashapp') {
      // For Cash App, we need to specify it as a payment method type
      paymentIntentData.payment_method_types = ['cashapp'];
      paymentIntentData.payment_method_data = {
        type: 'cashapp'
      };
    } else {
      // For other payment methods, use automatic payment methods
      paymentIntentData.automatic_payment_methods = { enabled: true };
    }

    // Add customer if available
    if (stripeCustomerId) {
      paymentIntentData.customer = stripeCustomerId;
    }

    // Add email for receipt (even if customer exists, this ensures receipt is sent)
    if (validatedEmail) {
      paymentIntentData.receipt_email = validatedEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentData,
      // { idempotencyKey }
    );

    // 9) Save payment record with enhanced data
    await db.collection('payments').doc(paymentIntent.id).set({
      userId,
      planId,
      customPlan,
      finalPrice: amountCents / 100,
      totalAmount: amountCents / 100,
      originalPrice: originalAmountCents / 100,
      discountCode: discountCode || null,
      discountAmount: discountAmountCents / 100,
      status: paymentIntent.status, // Don't assume succeeded
      isFreePlan: false,
      createdAt: new Date(),
      userEmail: validatedEmail || userEmail, // Store validated email if available
      userData,
      stripeCustomerId,
      stripePaymentIntentId: paymentIntent.id
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountCents / 100,
      currency: paymentIntent.currency,
      isFreePlan: false,
      customerId: stripeCustomerId
    };

  } catch (error) {
    console.error('createPaymentIntent error:', error);
    throw error;
  }
};

export const processCashAppPayment = async (paymentIntentId) => {
  try {
    // Check if this is a free plan (mock payment)
    if (paymentIntentId.startsWith('free_cashapp_')) {
      return {
        success: true,
        paymentIntentId,
        status: 'succeeded',
        amount: 0,
        isFreePlan: true,
        paymentMethod: 'cashapp'
      };
    }

    // Get current status from Stripe
    const stripePaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // For Cash App payments, we don't need to confirm with a payment method
    // The payment intent should already be in the correct state for Cash App
    console.log('Cash App payment status:', stripePaymentIntent.status);
    
    // Update Firestore with current status
    await db.collection('payments').doc(paymentIntentId).update({
      status: stripePaymentIntent.status,
      updatedAt: new Date()
    });

    return {
      success: true,
      paymentIntentId: stripePaymentIntent.id,
      status: stripePaymentIntent.status,
      amount: stripePaymentIntent.amount / 100,
      isFreePlan: false,
      paymentMethod: 'cashapp'
    };

  } catch (error) {
    console.error('Process Cash App payment error:', error);
    
    // Update payment status to failed in Firestore
    try {
      await db.collection('payments').doc(paymentIntentId).update({
        status: 'failed',
        error: error.message,
        updatedAt: new Date()
      });
    } catch (updateError) {
      console.error('Failed to update Cash App payment status:', updateError);
    }
    
    throw error;
  }
};

export const processPayment = async (paymentIntentId, paymentMethodId) => {
  try {
    // Check if this is a free plan (mock payment)
    if (paymentIntentId.startsWith('free_')) {
      return {
        success: true,
        paymentIntentId,
        status: 'succeeded',
        amount: 0,
        isFreePlan: true
      };
    }

    // First, check current status in Stripe
    const stripePaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // If already succeeded, just update Firestore and return
    if (stripePaymentIntent.status === 'succeeded') {
      await db.collection('payments').doc(paymentIntentId).update({
        status: 'succeeded',
        updatedAt: new Date()
      });
      
      return {
        success: true,
        paymentIntentId,
        status: 'succeeded',
        amount: stripePaymentIntent.amount / 100,
        isFreePlan: false
      };
    }

    // If not succeeded, try to confirm
    console.log('stripePaymentIntent', stripePaymentIntent);
    if (stripePaymentIntent.status === 'requires_payment_method') {
      try {
        // Check if this is a Cash App payment
        const isCashAppPayment = stripePaymentIntent.payment_method_types?.includes('cashapp');
        
        const confirmOptions = {
          payment_method: paymentMethodId,
          return_url: `${process.env.FRONTEND_URL || 'https://yourapp.com'}/payment-success`
        };

        // For Cash App payments, we need to handle the confirmation differently
        if (isCashAppPayment) {
          console.log('Processing Cash App payment confirmation');
          // Cash App payments may require additional handling
          // The confirmation will redirect to Cash App
        }

        const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, confirmOptions);

        // Update payment status in Firestore
        await db.collection('payments').doc(paymentIntentId).update({
          status: paymentIntent.status,
          updatedAt: new Date()
        });

        return {
          success: true,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount / 100,
          isFreePlan: false
        };
      } catch (confirmError) {
        // Handle the case where payment intent is already confirmed
        if (confirmError.code === 'payment_intent_unexpected_state') {
          console.log('Payment intent already confirmed, retrieving latest status');
          
          // Get the latest status from Stripe
          const latestPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          
          // Update Firestore with the latest status
          await db.collection('payments').doc(paymentIntentId).update({
            status: latestPaymentIntent.status,
            updatedAt: new Date()
          });

          return {
            success: true,
            paymentIntentId: latestPaymentIntent.id,
            status: latestPaymentIntent.status,
            amount: latestPaymentIntent.amount / 100,
            isFreePlan: false
          };
        }
        
        // Re-throw other errors
        throw confirmError;
      }
    }

    // For other statuses, just return current status
    return {
      success: true,
      paymentIntentId,
      status: stripePaymentIntent.status,
      amount: stripePaymentIntent.amount / 100,
      isFreePlan: false
    };

  } catch (error) {
    console.error('Process payment error:', error);
    
    // Update payment status to failed in Firestore
    try {
      await db.collection('payments').doc(paymentIntentId).update({
        status: 'failed',
        error: error.message,
        updatedAt: new Date()
      });
    } catch (updateError) {
      console.error('Failed to update payment status:', updateError);
    }
    
    throw error;
  }
};

export const getPaymentStatus = async (paymentIntentId) => {
  try {
    if (paymentIntentId.startsWith('free_')) {
      return { status: 'succeeded', isFreePlan: true };
    }

    // Get status from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Sync status with Firestore if different
    const firestoreDoc = await db.collection('payments').doc(paymentIntentId).get();
    if (firestoreDoc.exists) {
      const firestoreData = firestoreDoc.data();
      if (firestoreData.status !== paymentIntent.status) {
        // Update Firestore to match Stripe
        await db.collection('payments').doc(paymentIntentId).update({
          status: paymentIntent.status,
          updatedAt: new Date()
        });
        console.log(`Synced payment status: ${firestoreData.status} -> ${paymentIntent.status}`);
      }
    }
    
    return { 
      status: paymentIntent.status, 
      isFreePlan: false,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency
    };
  } catch (error) {
    console.error('Error getting payment status:', error);
    throw error;
  }
};

export const refundPayment = async (paymentIntentId, reason = 'requested_by_customer') => {
  try {
    if (paymentIntentId.startsWith('free_')) {
      throw new Error('Cannot refund free plans');
    }

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: reason
    });

    // Update payment record
    await db.collection('payments').doc(paymentIntentId).update({
      refunded: true,
      refundId: refund.id,
      refundReason: reason,
      refundedAt: new Date()
    });

    return {
      refundId: refund.id,
      amount: refund.amount / 100,
      status: refund.status,
      reason: refund.reason
    };
  } catch (error) {
    console.error('Error processing refund:', error);
    throw error;
  }
};

/**
 * Manually sync payment status from Stripe to Firestore
 * Useful for fixing payment status issues
 */
export const syncPaymentStatus = async (paymentIntentId) => {
  try {
    if (paymentIntentId.startsWith('free_')) {
      return { status: 'succeeded', isFreePlan: true };
    }

    // Get current status from Stripe
    const stripePaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Update Firestore with current Stripe status
    await db.collection('payments').doc(paymentIntentId).update({
      status: stripePaymentIntent.status,
      updatedAt: new Date(),
      lastSynced: new Date()
    });

    console.log(`Payment status synced: ${paymentIntentId} -> ${stripePaymentIntent.status}`);

    return {
      paymentIntentId,
      status: stripePaymentIntent.status,
      amount: stripePaymentIntent.amount / 100,
      currency: stripePaymentIntent.currency,
      synced: true
    };
  } catch (error) {
    console.error('Error syncing payment status:', error);
    throw error;
  }
};

// New function to just retrieve payment status (for frontend-confirmed payments)
export const retrievePaymentStatus = async (paymentIntentId) => {
  try {
    // Check if this is a free plan (mock payment)
    if (paymentIntentId.startsWith('free_')) {
      return {
        success: true,
        paymentIntentId,
        status: 'succeeded',
        amount: 0,
        isFreePlan: true
      };
    }

    // Get current status from Stripe
    const stripePaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Update Firestore with current status
    await db.collection('payments').doc(paymentIntentId).update({
      status: stripePaymentIntent.status,
      updatedAt: new Date()
    });

    return {
      success: true,
      paymentIntentId,
      status: stripePaymentIntent.status,
      amount: stripePaymentIntent.amount / 100,
      isFreePlan: false
    };

  } catch (error) {
    console.error('Retrieve payment status error:', error);
    throw error;
  }
};

/**
 * Create a payment intent specifically for Cash App payments
 * This function creates a payment intent that's optimized for Cash App payment flow
 * @param {string} userId - Authenticated user ID
 * @param {string} planId - Pricing plan ID
 * @param {Object} customPlan - Custom plan configuration
 * @param {number} clientFinalPrice - Client-calculated price (for validation)
 * @param {string} discountCode - Optional discount code
 * @param {string} userEmail - User's email for Stripe
 * @param {Object} userData - Additional user data
 */
export const createCashAppPaymentIntent = async (userId, planId, customPlan, clientFinalPrice, discountCode = null, userEmail = null, userData = {}) => {
  // IMPORTANT: caller must have already authenticated userId === req.user.uid
  try {
    // 1) Fetch plan and compute server-side price
    const planDoc = await db.collection('pricingPlans').doc(planId).get();
    if (!planDoc.exists) {
      throw new Error('Invalid planId');
    }
    const plan = planDoc.data();

    // Compute server-side price in cents
    const serverCalculatedCents = computeAmountFromPlan(plan, customPlan);

    // 2) Calculate original price and validate client price
    let amountCents = serverCalculatedCents;
    let originalAmountCents = serverCalculatedCents;
    
    let discountAmountCents = 0;

    // 3) Handle discount code
    if (discountCode) {
      try {
        const { validateDiscountCode } = await import('./discountcode.service.js');
        const validationResult = await validateDiscountCode(discountCode);
        
        if (!validationResult.isValid) {
          throw new Error(`Invalid discount code: ${validationResult.error}`);
        }
        
        const discountCodeData = validationResult.discountCode;
        
        if (discountCodeData.discountType === 'percentage') {
          discountAmountCents = Math.round(amountCents * (discountCodeData.discountValue / 100));
        } else if (discountCodeData.discountType === 'fixed') {
          discountAmountCents = Math.round(discountCodeData.discountValue * 100);
        }
        
        discountAmountCents = Math.min(discountAmountCents, amountCents);
        amountCents -= discountAmountCents;
        
      } catch (discountError) {
        console.error('Discount code validation error in Cash App payment intent:', discountError);
        throw new Error(`Discount code validation failed: ${discountError.message}`);
      }
    }

    // 4) Validate client price
    if (typeof clientFinalPrice === 'number') {
      const clientCents = Math.round(clientFinalPrice * 100);
      
      if (!discountCode) {
        amountCents = clientCents;
      } else if (clientCents !== amountCents) {
        throw new Error('Price validation failed - client and server prices do not match');
      }
    }

    // 5) Enforce minimum charge (50 cents)
    if (amountCents > 0 && amountCents < 50) {
      amountCents = 50;
    }

    // 6) Handle free plans
    if (amountCents <= 0) {
      const mockPaymentId = `free_cashapp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      await db.collection('payments').doc(mockPaymentId).set({
        userId,
        planId,
        customPlan,
        finalPrice: 0,
        totalAmount: 0,
        originalPrice: originalAmountCents / 100,
        discountCode: discountCode || null,
        discountAmount: discountAmountCents / 100,
        status: 'succeeded',
        isFreePlan: true,
        paymentMethod: 'cashapp',
        createdAt: new Date(),
        userEmail,
        userData
      });

      return {
        clientSecret: null,
        paymentIntentId: mockPaymentId,
        amount: 0,
        currency: 'usd',
        isFreePlan: true,
        paymentMethod: 'cashapp'
      };
    }

    // 7) Create or retrieve Stripe customer
    let stripeCustomerId = null;
    const validatedEmail = validateAndFormatEmail(userEmail);
    
    if (validatedEmail) {
      try {
        const customers = await stripe.customers.list({
          email: validatedEmail,
          limit: 1
        });

        if (customers.data.length > 0) {
          stripeCustomerId = customers.data[0].id;
          await stripe.customers.update(stripeCustomerId, {
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              lastPayment: new Date().toISOString()
            }
          });
        } else {
          const customer = await stripe.customers.create({
            email: validatedEmail,
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              createdAt: new Date().toISOString()
            }
          });
          stripeCustomerId = customer.id;
        }
      } catch (customerError) {
        console.warn('Failed to create/update Stripe customer for Cash App payment:', customerError);
      }
    }

    // 8) Create Cash App specific PaymentIntent
    const paymentIntentData = {
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['cashapp'],
      payment_method_data: {
        type: 'cashapp'
      },
      metadata: {
        userId,
        planId,
        discountCode: discountCode || '',
        isFreePlan: 'false',
        paymentMethod: 'cashapp',
        guestLimit: customPlan.guestLimit?.toString() || '',
        photoPool: customPlan.photoPool?.toString() || '',
        storageDays: customPlan.storageDays?.toString() || ''
      }
    };

    if (stripeCustomerId) {
      paymentIntentData.customer = stripeCustomerId;
    }

    if (validatedEmail) {
      paymentIntentData.receipt_email = validatedEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    // 9) Save payment record
    await db.collection('payments').doc(paymentIntent.id).set({
      userId,
      planId,
      customPlan,
      finalPrice: amountCents / 100,
      totalAmount: amountCents / 100,
      originalPrice: originalAmountCents / 100,
      discountCode: discountCode || null,
      discountAmount: discountAmountCents / 100,
      status: paymentIntent.status,
      isFreePlan: false,
      paymentMethod: 'cashapp',
      createdAt: new Date(),
      userEmail: validatedEmail || userEmail,
      userData,
      stripeCustomerId,
      stripePaymentIntentId: paymentIntent.id
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountCents / 100,
      currency: paymentIntent.currency,
      isFreePlan: false,
      paymentMethod: 'cashapp',
      customerId: stripeCustomerId
    };

  } catch (error) {
    console.error('createCashAppPaymentIntent error:', error);
    throw error;
  }
};

/**
 * Create a payment intent specifically for event upgrades
 * Calculates the difference between new plan price and existing event price
 * @param {string} userId - Authenticated user ID
 * @param {string} eventId - Event ID to upgrade
 * @param {string} planId - New pricing plan ID
 * @param {Object} customPlan - New custom plan configuration
 * @param {number} clientUpgradePrice - Client-calculated upgrade price (for validation)
 * @param {string} discountCode - Optional discount code
 * @param {string} userEmail - User's email for Stripe
 * @param {Object} userData - Additional user data
 */
export const createUpgradePaymentIntent = async (userId, eventId, planId, customPlan, clientUpgradePrice, discountCode = null, userEmail = null, userData = {}, paymentMethod = null) => {
  try {
    // 1) Verify event exists and belongs to user
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      throw new Error('Event not found');
    }
    
    const existingEvent = eventDoc.data();
    if (existingEvent.userId !== userId) {
      throw new Error('Event does not belong to this user');
    }

    // 2) Fetch new plan and compute server-side price
    const planDoc = await db.collection('pricingPlans').doc(planId).get();
    if (!planDoc.exists) {
      throw new Error('Invalid planId');
    }
    const plan = planDoc.data();

    // 3) Calculate upgrade amount
    const newPlanPriceCents = computeAmountFromPlan(plan, customPlan);
    const existingPriceCents = Math.round((existingEvent.finalPrice || 0) * 100);
    const upgradeCents = newPlanPriceCents - existingPriceCents;

    console.log('Upgrade calculation:', {
      userId,
      eventId,
      existingPrice: existingPriceCents / 100,
      newPlanPrice: newPlanPriceCents / 100,
      upgradeAmount: upgradeCents / 100
    });

    // 4) Validate upgrade amount
    if (upgradeCents < 0) {
      throw new Error('Downgrades or negative price differences are not allowed');
    }

    // 5) Initialize amountCents and use client upgrade price (no validation)
    let amountCents = upgradeCents; // Default to calculated upgrade amount
    
    if (typeof clientUpgradePrice === 'number') {
      const clientCents = Math.round(clientUpgradePrice * 100);
      amountCents = clientCents; // Use client price directly
      console.log('Using client upgrade price:', {
        userId, 
        eventId,
        planId, 
        clientCents,
        calculatedUpgradeCents: upgradeCents,
        customPlan 
      });
    }

    // 6) Handle free upgrades
    if (upgradeCents <= 0) {
      const mockPaymentId = `free_upgrade_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      await db.collection('payments').doc(mockPaymentId).set({
        userId,
        eventId,
        planId,
        customPlan,
        finalPrice: 0,
        totalAmount: 0,
        discountCode,
        discountAmount: 0,
        status: 'succeeded',
        isFreePlan: true,
        isUpgrade: true,
        existingPrice: existingPriceCents / 100,
        newPlanPrice: newPlanPriceCents / 100,
        upgradeAmount: 0,
        createdAt: new Date(),
        userEmail,
        userData,
        paymentMethod: paymentMethod || null
      });

      return {
        clientSecret: null,
        paymentIntentId: mockPaymentId,
        amount: 0,
        currency: 'usd',
        isFreePlan: true,
        isUpgrade: true,
        existingPrice: existingPriceCents / 100,
        newPlanPrice: newPlanPriceCents / 100,
        upgradeAmount: 0,
        paymentMethod: paymentMethod || null
      };
    }

    // 7) Handle discount code
    let discountAmountCents = 0;

    if (discountCode) {
      const discountRef = db.collection('discountCodes').doc(discountCode);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(discountRef);
        if (!snap.exists) {
          throw new Error('Invalid discount code');
        }
        
        const discount = snap.data();
        const now = new Date();

        if (!discount.isActive) {
          throw new Error('Discount code is inactive');
        }
        
        if (discount.expiresAt && now > discount.expiresAt.toDate()) {
          throw new Error('Discount code has expired');
        }
        
        if (discount.usedCount >= discount.maxUses) {
          throw new Error('Discount code usage limit reached');
        }

        discountAmountCents = Math.round(amountCents * (discount.percentOff / 100));
        amountCents -= discountAmountCents;

        tx.update(discountRef, { 
          usedCount: (discount.usedCount || 0) + 1,
          lastUsedAt: new Date()
        });
      });
    }

    // 8) Enforce minimum charge (50 cents)
    if (amountCents > 0 && amountCents < 50) {
      amountCents = 50;
    }

    // 9) Create Stripe customer (same logic as createPaymentIntent)
    let stripeCustomerId = null;
    const validatedEmail = validateAndFormatEmail(userEmail);
    
    if (validatedEmail) {
      try {
        const customers = await stripe.customers.list({
          email: validatedEmail,
          limit: 1
        });

        if (customers.data.length > 0) {
          stripeCustomerId = customers.data[0].id;
          await stripe.customers.update(stripeCustomerId, {
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              lastPayment: new Date().toISOString()
            }
          });
        } else {
          const customer = await stripe.customers.create({
            email: validatedEmail,
            name: userData.fullName || userData.displayName,
            metadata: {
              firebaseUserId: userId,
              createdAt: new Date().toISOString()
            }
          });
          stripeCustomerId = customer.id;
        }
      } catch (customerError) {
        console.warn('Failed to create/update Stripe customer:', customerError);
      }
    }

    // 10) Create idempotency key for upgrades
    const idempotencyKey = `upgrade_${userId}_${eventId}_${planId}_${crypto.createHash('sha256')
      .update(JSON.stringify({ customPlan, discountCode, clientUpgradePrice: amountCents }))
      .digest('hex')
      .substring(0, 16)}`;

    // 11) Create PaymentIntent
    const paymentIntentData = {
      amount: amountCents,
      currency: 'usd',
      metadata: {
        userId,
        eventId,
        planId,
        discountCode: discountCode || '',
        isFreePlan: 'false',
        isUpgrade: 'true',
        existingPrice: existingPriceCents.toString(),
        newPlanPrice: newPlanPriceCents.toString(),
        upgradeAmount: upgradeCents.toString(),
        guestLimit: customPlan.guestLimit?.toString() || '',
        photoPool: customPlan.photoPool?.toString() || '',
        storageDays: customPlan.storageDays?.toString() || ''
      }
    };

    // Handle specific payment method types for upgrades
    if (paymentMethod === 'cashapp') {
      // Configure for Cash App payments
      paymentIntentData.payment_method_types = ['cashapp'];
      paymentIntentData.payment_method_data = {
        type: 'cashapp'
      };
      paymentIntentData.metadata.paymentMethod = 'cashapp';
    } else {
      // Use automatic payment methods for other payment types
      paymentIntentData.automatic_payment_methods = { enabled: true };
    }

    if (stripeCustomerId) {
      paymentIntentData.customer = stripeCustomerId;
    }

    if (validatedEmail) {
      paymentIntentData.receipt_email = validatedEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentData,
      { idempotencyKey }
    );

    // 12) Save payment record
    await db.collection('payments').doc(paymentIntent.id).set({
      userId,
      eventId,
      planId,
      customPlan,
      finalPrice: amountCents / 100,
      totalAmount: amountCents / 100,
      discountCode,
      discountAmount: discountAmountCents / 100,
      status: paymentIntent.status,
      isFreePlan: false,
      isUpgrade: true,
      existingPrice: existingPriceCents / 100,
      newPlanPrice: newPlanPriceCents / 100,
      upgradeAmount: upgradeCents / 100,
      createdAt: new Date(),
      userEmail: validatedEmail || userEmail,
      userData,
      stripeCustomerId,
      stripePaymentIntentId: paymentIntent.id,
      paymentMethod: paymentMethod || null
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountCents / 100,
      currency: paymentIntent.currency,
      isFreePlan: false,
      isUpgrade: true,
      existingPrice: existingPriceCents / 100,
      newPlanPrice: newPlanPriceCents / 100,
      upgradeAmount: upgradeCents / 100,
      customerId: stripeCustomerId,
      paymentMethod: paymentMethod || null
    };

  } catch (error) {
    console.error('createUpgradePaymentIntent error:', error);
    throw error;
  }
};