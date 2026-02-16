import paypalSdk from '@paypal/paypal-server-sdk';
import { db } from './firebase.service.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Ensure PayPal credentials are properly configured
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET environment variables are required');
}

// Initialize PayPal client
const { Client: PayPalClient, Environment, OrdersController, PaymentsController } = paypalSdk;

const environment = process.env.PAYPAL_MODE === 'live' 
  ? Environment.Production 
  : Environment.Sandbox;

const paypalClient = new PayPalClient({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  timeout: 0,
  environment: environment,
  logging: {
    logLevel: 'info',
    logRequest: { logBody: true },
    logResponse: { logHeaders: true },
  },
});

// Initialize controllers
const ordersController = new OrdersController(paypalClient);
const paymentsController = new PaymentsController(paypalClient);

/**
 * Validate and format email address for PayPal
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
 * Reused from Stripe service logic
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
  
  // Return amount in dollars (PayPal uses dollars, not cents like Stripe)
  return totalAmount;
}

/**
 * Create a PayPal order for payment
 * @param {string} userId - Authenticated user ID
 * @param {string} planId - Pricing plan ID
 * @param {Object} customPlan - Custom plan configuration
 * @param {number} clientFinalPrice - Client-calculated price (for validation)
 * @param {string} discountCode - Optional discount code
 * @param {string} userEmail - User's email for PayPal
 * @param {Object} userData - Additional user data
 */
export const createPayPalOrder = async (userId, planId, customPlan, clientFinalPrice, discountCode = null, userEmail = null, userData = {}) => {
  try {
    // 1) Fetch plan and compute server-side price
    const planDoc = await db.collection('pricingPlans').doc(planId).get();
    if (!planDoc.exists) {
      throw new Error('Invalid planId');
    }
    const plan = planDoc.data();

    // Compute server-side price in dollars
    const serverCalculatedAmount = computeAmountFromPlan(plan, customPlan);

    // 2) Calculate original price and validate client price
    let amount = serverCalculatedAmount;
    let originalAmount = serverCalculatedAmount;
    
    let discountAmount = 0;

    // 3) Handle discount code with validation mechanism
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
          discountAmount = amount * (discountCodeData.discountValue / 100);
        } else if (discountCodeData.discountType === 'fixed') {
          discountAmount = discountCodeData.discountValue;
        }
        
        // Ensure discount doesn't exceed the total amount
        discountAmount = Math.min(discountAmount, amount);
        
        // Apply discount
        amount -= discountAmount;
        
        console.log('Discount applied in PayPal order:', {
          code: discountCode,
          type: discountCodeData.discountType,
          value: discountCodeData.discountValue,
          discountAmount,
          originalAmount: serverCalculatedAmount,
          finalAmount: amount
        });
        
      } catch (discountError) {
        console.error('Discount code validation error in PayPal order:', discountError);
        throw new Error(`Discount code validation failed: ${discountError.message}`);
      }
    }

    // 3.1) Validate client price against final calculated price (with discount applied)
    if (typeof clientFinalPrice === 'number') {
      // If no discount code provided, accept client's price as final price
      if (!discountCode) {
        console.log('No discount code provided, using client price as final price:', {
          userId,
          planId,
          clientPrice: clientFinalPrice,
          serverCalculatedAmount,
          originalPrice: serverCalculatedAmount
        });
        amount = clientFinalPrice; // Use client's price
      } else if (Math.abs(clientFinalPrice - amount) > 0.01) { // Allow 1 cent difference for rounding
        // If discount code provided, validate the calculated price
        console.warn('Client finalPrice mismatch detected in PayPal order', { 
          userId, 
          planId, 
          clientPrice: clientFinalPrice, 
          serverCalculatedAmount,
          amount,
          discountAmount,
          discountCode,
          customPlan 
        });
        throw new Error('Price validation failed - client and server prices do not match');
      }
    }

    // 4) Enforce minimum charge ($0.50)
    if (amount > 0 && amount < 0.50) {
      amount = 0.50;
    }

    // 5) Handle free plans
    if (amount <= 0) {
      const mockOrderId = `free_paypal_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      await db.collection('payments').doc(mockOrderId).set({
        userId,
        planId,
        customPlan,
        finalPrice: 0,
        totalAmount: 0,
        originalPrice: originalAmount,
        discountCode: discountCode || null,
        discountAmount: discountAmount,
        status: 'COMPLETED',
        isFreePlan: true,
        paymentMethod: 'paypal',
        createdAt: new Date(),
        userEmail,
        userData
      });

      return {
        orderId: mockOrderId,
        amount: 0,
        currency: 'USD',
        isFreePlan: true
      };
    }

    // 6) Validate and format email
    const validatedEmail = validateAndFormatEmail(userEmail);

    // 7) Create PayPal order
    const returnUrl = process.env.PAYPAL_RETURN_URL || `http://localhost:3000/payment-success`;
    const cancelUrl = process.env.PAYPAL_CANCEL_URL || `http://localhost:3000/payment-cancel`;

    console.log('PayPal URLs configured:', { returnUrl, cancelUrl });

    const orderRequest = {
      body: {
        intent: 'CAPTURE',
        purchaseUnits: [
          {
            amount: {
              currencyCode: 'USD',
              value: amount.toFixed(2), // PayPal requires string with 2 decimal places
            },
            description: `${plan.name || 'Event Plan'} - ${customPlan.guestLimit} guests, ${customPlan.photoPool} photos`,
          },
        ],
        applicationContext: {
          returnUrl: returnUrl,
          cancelUrl: cancelUrl,
          brandName: 'Overlay Pix',
          landingPage: 'BILLING',
          userAction: 'PAY_NOW',
        },
      },
    };

    // Add payer email if available
    if (validatedEmail) {
      orderRequest.body.payer = {
        emailAddress: validatedEmail,
      };
    }

    const response = await ordersController.createOrder(orderRequest);
    const order = response.result || response.body;

    console.log('PayPal order created - Full response:', JSON.stringify(response, null, 2));
    console.log('PayPal order created:', {
      orderId: order.id,
      status: order.status,
      amount: amount
    });

    // 8) Save payment record
    await db.collection('payments').doc(order.id).set({
      userId,
      planId,
      customPlan,
      finalPrice: amount,
      totalAmount: amount,
      originalPrice: originalAmount,
      discountCode: discountCode || null,
      discountAmount: discountAmount,
      status: order.status, // CREATED, APPROVED, COMPLETED, etc.
      isFreePlan: false,
      paymentMethod: 'paypal',
      createdAt: new Date(),
      userEmail: validatedEmail || userEmail,
      userData,
      paypalOrderId: order.id
    });

    return {
      orderId: order.id,
      amount: amount,
      currency: 'USD',
      isFreePlan: false,
      approvalUrl: order.links?.find(link => link.rel === 'approve')?.href
    };

  } catch (error) {
    console.error('createPayPalOrder error:', error);
    throw error;
  }
};

/**
 * Capture a PayPal order (complete the payment)
 * @param {string} orderId - PayPal order ID
 */
export const capturePayPalOrder = async (orderId) => {
  try {
    // Check if this is a free plan (mock payment)
    if (orderId.startsWith('free_paypal_')) {
      return {
        success: true,
        orderId,
        status: 'COMPLETED',
        amount: 0,
        isFreePlan: true,
        paymentMethod: 'paypal'
      };
    }

    // Capture the PayPal order
    const response = await ordersController.captureOrder({
      id: orderId,
      prefer: 'return=representation',
    });
    const captureData = response.result || response.body;

    console.log('PayPal order captured:', {
      orderId: captureData.id,
      status: captureData.status
    });

    // Update Firestore with captured status
    await db.collection('payments').doc(orderId).update({
      status: captureData.status,
      capturedAt: new Date(),
      updatedAt: new Date(),
      captureDetails: {
        captureId: captureData.purchaseUnits?.[0]?.payments?.captures?.[0]?.id,
        payerId: captureData.payer?.payerId,
        payerEmail: captureData.payer?.emailAddress,
      }
    });

    return {
      success: true,
      orderId: captureData.id,
      status: captureData.status,
      amount: parseFloat(captureData.purchaseUnits?.[0]?.amount?.value || 0),
      isFreePlan: false,
      paymentMethod: 'paypal'
    };

  } catch (error) {
    console.error('Capture PayPal order error:', error);
    
    // Update payment status to failed in Firestore
    try {
      await db.collection('payments').doc(orderId).update({
        status: 'FAILED',
        error: error.message,
        updatedAt: new Date()
      });
    } catch (updateError) {
      console.error('Failed to update PayPal order status:', updateError);
    }
    
    throw error;
  }
};

/**
 * Get PayPal order status
 * @param {string} orderId - PayPal order ID
 */
export const getPayPalOrderStatus = async (orderId) => {
  try {
    if (orderId.startsWith('free_paypal_')) {
      return { status: 'COMPLETED', isFreePlan: true };
    }

    // Get order details from PayPal
    const response = await ordersController.getOrder({ id: orderId });
    const order = response.result || response.body;
    
    // Sync status with Firestore if different
    const firestoreDoc = await db.collection('payments').doc(orderId).get();
    if (firestoreDoc.exists && order.status) {
      const firestoreData = firestoreDoc.data();
      if (firestoreData.status !== order.status) {
        // Update Firestore to match PayPal
        await db.collection('payments').doc(orderId).update({
          status: order.status,
          updatedAt: new Date()
        });
        console.log(`Synced PayPal order status: ${firestoreData.status} -> ${order.status}`);
      }
    }
    
    return { 
      status: order.status, 
      isFreePlan: false,
      amount: parseFloat(order.purchaseUnits?.[0]?.amount?.value || 0),
      currency: order.purchaseUnits?.[0]?.amount?.currencyCode || 'USD'
    };
  } catch (error) {
    console.error('Error getting PayPal order status:', error);
    throw error;
  }
};

/**
 * Refund a PayPal payment
 * @param {string} orderId - PayPal order ID
 * @param {string} reason - Refund reason
 */
export const refundPayPalPayment = async (orderId, reason = 'Customer requested refund') => {
  try {
    if (orderId.startsWith('free_paypal_')) {
      throw new Error('Cannot refund free plans');
    }

    // Get the capture ID from the order
    const paymentDoc = await db.collection('payments').doc(orderId).get();
    if (!paymentDoc.exists) {
      throw new Error('Payment record not found');
    }

    const paymentData = paymentDoc.data();
    const captureId = paymentData.captureDetails?.captureId;

    if (!captureId) {
      throw new Error('Capture ID not found. Payment may not be completed.');
    }

    // Create refund request
    const { body: refund } = await paymentsController.refundCapturedPayment({
      captureId: captureId,
      body: {
        note_to_payer: reason,
      },
    });

    // Update payment record
    await db.collection('payments').doc(orderId).update({
      refunded: true,
      refundId: refund.id,
      refundReason: reason,
      refundedAt: new Date(),
      refundStatus: refund.status
    });

    return {
      refundId: refund.id,
      amount: parseFloat(refund.amount?.value || 0),
      status: refund.status,
      reason: reason
    };
  } catch (error) {
    console.error('Error processing PayPal refund:', error);
    throw error;
  }
};

/**
 * Create a PayPal order for event upgrade
 * @param {string} userId - Authenticated user ID
 * @param {string} eventId - Event ID to upgrade
 * @param {string} planId - New pricing plan ID
 * @param {Object} customPlan - New custom plan configuration
 * @param {number} clientUpgradePrice - Client-calculated upgrade price
 * @param {string} discountCode - Optional discount code
 * @param {string} userEmail - User's email
 * @param {Object} userData - Additional user data
 */
export const createPayPalUpgradeOrder = async (userId, eventId, planId, customPlan, clientUpgradePrice, discountCode = null, userEmail = null, userData = {}) => {
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
    const newPlanPrice = computeAmountFromPlan(plan, customPlan);
    const existingPrice = existingEvent.finalPrice || 0;
    const upgradeAmount = newPlanPrice - existingPrice;

    console.log('PayPal upgrade calculation:', {
      userId,
      eventId,
      existingPrice,
      newPlanPrice,
      upgradeAmount
    });

    // 4) Validate upgrade amount
    if (upgradeAmount < 0) {
      throw new Error('Downgrades or negative price differences are not allowed');
    }

    // 5) Use client upgrade price
    let amount = upgradeAmount;
    
    if (typeof clientUpgradePrice === 'number') {
      amount = clientUpgradePrice;
      console.log('Using client upgrade price:', {
        userId, 
        eventId,
        planId, 
        clientUpgradePrice,
        calculatedUpgradeAmount: upgradeAmount,
        customPlan 
      });
    }

    // 6) Handle free upgrades
    if (amount <= 0) {
      const mockOrderId = `free_paypal_upgrade_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      await db.collection('payments').doc(mockOrderId).set({
        userId,
        eventId,
        planId,
        customPlan,
        finalPrice: 0,
        totalAmount: 0,
        discountCode,
        discountAmount: 0,
        status: 'COMPLETED',
        isFreePlan: true,
        isUpgrade: true,
        existingPrice,
        newPlanPrice,
        upgradeAmount: 0,
        paymentMethod: 'paypal',
        createdAt: new Date(),
        userEmail,
        userData
      });

      return {
        orderId: mockOrderId,
        amount: 0,
        currency: 'USD',
        isFreePlan: true,
        isUpgrade: true,
        existingPrice,
        newPlanPrice,
        upgradeAmount: 0
      };
    }

    // 7) Validate and format email
    const validatedEmail = validateAndFormatEmail(userEmail);

    // 8) Create PayPal order for upgrade
    const orderRequest = {
      body: {
        intent: 'CAPTURE',
        purchaseUnits: [
          {
            amount: {
              currencyCode: 'USD',
              value: amount.toFixed(2),
            },
            description: `Event Upgrade - ${plan.name || 'New Plan'}`,
          },
        ],
        applicationContext: {
          returnUrl: process.env.PAYPAL_RETURN_URL || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success`,
          cancelUrl: process.env.PAYPAL_CANCEL_URL || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel`,
          brandName: 'Overlay Pix',
          landingPage: 'BILLING',
          userAction: 'PAY_NOW',
        },
      },
    };

    if (validatedEmail) {
      orderRequest.body.payer = {
        emailAddress: validatedEmail,
      };
    }

    const response = await ordersController.createOrder(orderRequest);
    const order = response.result || response.body;

    console.log('PayPal upgrade order created:', {
      orderId: order.id,
      status: order.status,
      amount: amount
    });

    // 9) Save payment record
    await db.collection('payments').doc(order.id).set({
      userId,
      eventId,
      planId,
      customPlan,
      finalPrice: amount,
      totalAmount: amount,
      discountCode,
      discountAmount: 0,
      status: order.status,
      isFreePlan: false,
      isUpgrade: true,
      existingPrice,
      newPlanPrice,
      upgradeAmount: amount,
      paymentMethod: 'paypal',
      createdAt: new Date(),
      userEmail: validatedEmail || userEmail,
      userData,
      paypalOrderId: order.id
    });

    return {
      orderId: order.id,
      amount: amount,
      currency: 'USD',
      isFreePlan: false,
      isUpgrade: true,
      existingPrice,
      newPlanPrice,
      upgradeAmount: amount,
      approvalUrl: order.links?.find(link => link.rel === 'approve')?.href
    };

  } catch (error) {
    console.error('createPayPalUpgradeOrder error:', error);
    throw error;
  }
};

/**
 * Manually sync PayPal order status from PayPal to Firestore
 */
export const syncPayPalOrderStatus = async (orderId) => {
  try {
    if (orderId.startsWith('free_paypal_')) {
      return { status: 'COMPLETED', isFreePlan: true };
    }

    // Get current status from PayPal
    const response = await ordersController.getOrder({ id: orderId });
    const order = response.result || response.body;
    
    // Update Firestore with current PayPal status
    if (order.status) {
      await db.collection('payments').doc(orderId).update({
        status: order.status,
        updatedAt: new Date(),
        lastSynced: new Date()
      });
    }

    console.log(`PayPal order status synced: ${orderId} -> ${order.status}`);

    return {
      orderId,
      status: order.status,
      amount: parseFloat(order.purchaseUnits?.[0]?.amount?.value || 0),
      currency: order.purchaseUnits?.[0]?.amount?.currencyCode || 'USD',
      synced: true
    };
  } catch (error) {
    console.error('Error syncing PayPal order status:', error);
    throw error;
  }
};
