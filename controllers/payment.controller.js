import { 
    createPaymentIntent, 
    createCashAppPaymentIntent,
    createUpgradePaymentIntent,
    processPayment, 
    processCashAppPayment,
    getPaymentStatus, 
    refundPayment 
  } from '../services/stripe.service.js';
  import {
    createPayPalOrder,
    capturePayPalOrder,
    getPayPalOrderStatus,
    refundPayPalPayment,
    createPayPalUpgradeOrder,
    syncPayPalOrderStatus
  } from '../services/paypal.service.js';
  import { db } from '../services/firebase.service.js';
  import { auditPayment, auditPaymentUpgrade, AUDIT_STATUS } from '../services/audit.service.js';
  
  export const createIntent = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { planId, customPlan, finalPrice, discountCode, paymentMethodType } = req.body;
      
      if (!planId || !customPlan || finalPrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data for Stripe customer creation, but ensure no undefined values (Firestore error workaround)
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('Payment intent request details:', {
        userId,
        planId,
        customPlan,
        finalPrice,
        userEmail
      });

      const result = await createPaymentIntent(
        userId,
        planId,
        customPlan,
        finalPrice,
        discountCode,
        userEmail,
        userData,
        paymentMethodType
      );
      console.log('Payment intent result:', result);
      res.json({
        success: true,
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        customerId: result.customerId
      });
      
    } catch (error) {
      console.error('Create payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to create payment intent', 
        details: error.message 
      });
    }
  };

  export const createCashAppIntent = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { planId, customPlan, finalPrice, discountCode } = req.body;
      
      if (!planId || !customPlan || finalPrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data for Stripe customer creation
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('Cash App payment intent request details:', {
        userId,
        planId,
        customPlan,
        finalPrice,
        userEmail
      });

      const result = await createCashAppPaymentIntent(
        userId,
        planId,
        customPlan,
        finalPrice,
        discountCode,
        userEmail,
        userData
      );
      
      console.log('Cash App payment intent result:', result);
      res.json({
        success: true,
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        paymentMethod: 'cashapp',
        customerId: result.customerId
      });
      
    } catch (error) {
      console.error('Create Cash App payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to create Cash App payment intent', 
        details: error.message 
      });
    }
  };

  export const createUpgradeIntent = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { eventId, planId, customPlan, upgradePrice, discountCode, paymentMethod } = req.body;
      
      if (!eventId || !planId || !customPlan || upgradePrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields: eventId, planId, customPlan, upgradePrice' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data for Stripe customer creation
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('Upgrade payment intent request details:', {
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        userEmail,
        paymentMethod
      });

      const result = await createUpgradePaymentIntent(
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        discountCode,
        userEmail,
        userData,
        paymentMethod
      );
      console.log('Upgrade payment intent result:', result);
      res.json({
        success: true,
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        isUpgrade: result.isUpgrade,
        existingPrice: result.existingPrice,
        newPlanPrice: result.newPlanPrice,
        upgradeAmount: result.upgradeAmount,
        customerId: result.customerId,
        paymentMethod: paymentMethod || null
      });
      
    } catch (error) {
      console.error('Create upgrade payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to create upgrade payment intent', 
        details: error.message 
      });
    }
  };

  export const createCashAppUpgradeIntent = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { eventId, planId, customPlan, upgradePrice, discountCode } = req.body;
      
      if (!eventId || !planId || !customPlan || upgradePrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields: eventId, planId, customPlan, upgradePrice' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data for Stripe customer creation
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('Cash App upgrade payment intent request details:', {
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        userEmail
      });

      const result = await createUpgradePaymentIntent(
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        discountCode,
        userEmail,
        userData,
        'cashapp'
      );
      
      console.log('Cash App upgrade payment intent result:', result);
      res.json({
        success: true,
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        isUpgrade: result.isUpgrade,
        existingPrice: result.existingPrice,
        newPlanPrice: result.newPlanPrice,
        upgradeAmount: result.upgradeAmount,
        customerId: result.customerId,
        paymentMethod: 'cashapp'
      });
      
    } catch (error) {
      console.error('Create Cash App upgrade payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to create Cash App upgrade payment intent', 
        details: error.message 
      });
    }
  };

  export const confirmCashAppIntent = async (req, res) => {
    try {
      const { paymentIntentId } = req.body;
      
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Missing paymentIntentId' });
      }
  
      const result = await processCashAppPayment(paymentIntentId);
      
      // Audit log: Cash App payment confirmation
      if (result.status === 'succeeded') {
        // Get payment details from Firestore for audit
        const paymentDoc = await db.collection('payments').doc(paymentIntentId).get();
        if (paymentDoc.exists) {
          const paymentData = paymentDoc.data();
          await auditPayment(
            req.user?.uid || paymentData.userId,
            req.user?.email || paymentData.userEmail,
            paymentData.eventId,
            paymentData.eventName,
            paymentData.totalAmount,
            paymentData.planId,
            AUDIT_STATUS.SUCCESS,
            req
          );
        }
      }
      
      res.json({
        success: true,
        paymentIntentId: result.paymentIntentId,
        status: result.status,
        amount: result.amount,
        isFreePlan: result.isFreePlan,
        paymentMethod: 'cashapp'
      });
      
    } catch (error) {
      console.error('Confirm Cash App payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to confirm Cash App payment', 
        details: error.message 
      });
    }
  };

  export const confirmIntent = async (req, res) => {
    try {
      const { paymentIntentId, paymentMethodId } = req.body;
      
      if (!paymentIntentId || !paymentMethodId) {
        return res.status(400).json({ error: 'Missing paymentIntentId or paymentMethodId' });
      }
  
      const result = await processPayment(paymentIntentId, paymentMethodId);
      
      // Audit log: Payment confirmation
      if (result.status === 'succeeded') {
        // Get payment details from Firestore for audit
        const paymentDoc = await db.collection('payments').doc(paymentIntentId).get();
        if (paymentDoc.exists) {
          const paymentData = paymentDoc.data();
          await auditPayment(
            req.user?.uid || paymentData.userId,
            req.user?.email || paymentData.userEmail,
            paymentData.eventId,
            paymentData.eventName,
            paymentData.totalAmount,
            paymentData.planId,
            AUDIT_STATUS.SUCCESS,
            req
          );
        }
      }
      
      res.json({
        success: true,
        paymentIntentId: result.paymentIntentId,
        status: result.status,
        amount: result.amount,
        isFreePlan: result.isFreePlan
      });
      
    } catch (error) {
      console.error('Confirm payment intent error:', error);
      res.status(500).json({ 
        error: 'Failed to confirm payment', 
        details: error.message 
      });
    }
  };
  
  export const paymentStatus = async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      const result = await getPaymentStatus(paymentIntentId);
      
      res.json({
        success: true,
        status: result
      });
      
    } catch (error) {
      console.error('Get payment status error:', error);
      res.status(500).json({ 
        error: 'Failed to get payment status', 
        details: error.message 
      });
    }
  };
  
  export const refund = async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      const { reason } = req.body;
      
      const result = await refundPayment(paymentIntentId, reason);
      
      res.json({
        success: true,
        refund: result
      });
      
    } catch (error) {
      console.error('Refund payment error:', error);
      res.status(500).json({ 
        error: 'Failed to process refund', 
        details: error.message 
      });
    }
  };
  
  export const debugPlans = async (req, res) => {
    try {
      const plansSnapshot = await db.collection('pricingPlans').get();
      const plans = plansSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      res.json({
        success: true,
        plans,
        count: plans.length
      });
      
    } catch (error) {
      console.error('Debug plans error:', error);
      res.status(500).json({ 
        error: 'Failed to fetch plans', 
        details: error.message 
      });
    }
  };

  // Debug endpoint to check payment status
  export const debugPaymentStatus = async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment intent ID is required' });
      }

      // Get Firestore payment data
      const paymentDoc = await db.collection('payments').doc(paymentIntentId).get();
      const firestoreData = paymentDoc.exists ? paymentDoc.data() : null;

      // Get Stripe payment data
      let stripeData = null;
      try {
        const { getPaymentStatus } = await import('../services/stripe.service.js');
        stripeData = await getPaymentStatus(paymentIntentId);
      } catch (stripeError) {
        console.error('Stripe error:', stripeError);
      }

      res.json({
        success: true,
        paymentIntentId,
        firestore: firestoreData,
        stripe: stripeData,
        statusMatch: firestoreData?.status === stripeData?.status
      });
      
    } catch (error) {
      console.error('Debug payment status error:', error);
      res.status(500).json({ 
        error: 'Failed to debug payment status', 
        details: error.message 
      });
    }
  };

  // Manual sync payment status
  export const syncPaymentStatus = async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment intent ID is required' });
      }

      const { syncPaymentStatus: syncStatus } = await import('../services/stripe.service.js');
      const result = await syncStatus(paymentIntentId);
      
      res.json({
        success: true,
        message: 'Payment status synced successfully',
        result
      });
      
    } catch (error) {
      console.error('Sync payment status error:', error);
      res.status(500).json({ 
        error: 'Failed to sync payment status', 
        details: error.message 
      });
    }
  };

  // Retrieve payment status (for frontend-confirmed payments)
  export const retrievePaymentStatus = async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      
      if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment intent ID is required' });
      }

      const { retrievePaymentStatus: retrieveStatus } = await import('../services/stripe.service.js');
      const result = await retrieveStatus(paymentIntentId);
      
      res.json({
        success: true,
        paymentIntentId: result.paymentIntentId,
        status: result.status,
        amount: result.amount,
        isFreePlan: result.isFreePlan
      });
      
    } catch (error) {
      console.error('Retrieve payment status error:', error);
      res.status(500).json({ 
        error: 'Failed to retrieve payment status', 
        details: error.message 
      });
    }
  };

  // ============================================
  // PayPal Payment Controllers
  // ============================================

  /**
   * Create PayPal order for payment
   */
  export const createPayPalOrderController = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { planId, customPlan, finalPrice, discountCode } = req.body;
      
      if (!planId || !customPlan || finalPrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('PayPal order request details:', {
        userId,
        planId,
        customPlan,
        finalPrice,
        userEmail
      });

      const result = await createPayPalOrder(
        userId,
        planId,
        customPlan,
        finalPrice,
        discountCode,
        userEmail,
        userData
      );

      console.log('PayPal order result:', result);
      res.json({
        success: true,
        orderId: result.orderId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        paymentMethod: 'paypal',
        approvalUrl: result.approvalUrl
      });
      
    } catch (error) {
      console.error('Create PayPal order error:', error);
      res.status(500).json({ 
        error: 'Failed to create PayPal order', 
        details: error.message 
      });
    }
  };

  /**
   * Capture PayPal order (complete payment)
   */
  export const capturePayPalOrderController = async (req, res) => {
    try {
      const { orderId } = req.body;
      
      if (!orderId) {
        return res.status(400).json({ error: 'Missing orderId' });
      }

      const result = await capturePayPalOrder(orderId);
      
      // Audit log: PayPal payment capture
      if (result.status === 'COMPLETED') {
        // Get payment details from Firestore for audit
        const paymentDoc = await db.collection('payments').doc(orderId).get();
        if (paymentDoc.exists) {
          const paymentData = paymentDoc.data();
          await auditPayment(
            req.user?.uid || paymentData.userId,
            req.user?.email || paymentData.userEmail,
            paymentData.eventId,
            paymentData.eventName,
            paymentData.totalAmount,
            paymentData.planId,
            AUDIT_STATUS.SUCCESS,
            req
          );
        }
      }
      
      res.json({
        success: true,
        orderId: result.orderId,
        status: result.status,
        amount: result.amount,
        isFreePlan: result.isFreePlan,
        paymentMethod: 'paypal'
      });
      
    } catch (error) {
      console.error('Capture PayPal order error:', error);
      res.status(500).json({ 
        error: 'Failed to capture PayPal order', 
        details: error.message 
      });
    }
  };

  /**
   * Get PayPal order status
   */
  export const paypalOrderStatusController = async (req, res) => {
    try {
      const { orderId } = req.params;
      const result = await getPayPalOrderStatus(orderId);
      
      res.json({
        success: true,
        status: result
      });
      
    } catch (error) {
      console.error('Get PayPal order status error:', error);
      res.status(500).json({ 
        error: 'Failed to get PayPal order status', 
        details: error.message 
      });
    }
  };

  /**
   * Create PayPal order for event upgrade
   */
  export const createPayPalUpgradeOrderController = async (req, res) => {
    try {
      // Use authenticated user ID instead of trusting client-provided userId
      const userId = req.user.uid;
      const { eventId, planId, customPlan, upgradePrice, discountCode } = req.body;
      
      if (!eventId || !planId || !customPlan || upgradePrice === undefined) {
        return res.status(400).json({ error: 'Missing required fields: eventId, planId, customPlan, upgradePrice' });
      }

      // Get user email from authenticated user or request body
      const userEmail = req.user.email || req.body.userEmail;

      // Prepare user data
      const userData = {};
      if (req.user.fullName || req.body.fullName) userData.fullName = req.user.fullName || req.body.fullName;
      if (req.user.displayName) userData.displayName = req.user.displayName;
      if (userEmail) userData.email = userEmail;
      if (req.user.phoneNumber || req.body.phoneNumber) userData.phoneNumber = req.user.phoneNumber || req.body.phoneNumber;

      console.log('PayPal upgrade order request details:', {
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        userEmail
      });

      const result = await createPayPalUpgradeOrder(
        userId,
        eventId,
        planId,
        customPlan,
        upgradePrice,
        discountCode,
        userEmail,
        userData
      );

      console.log('PayPal upgrade order result:', result);
      res.json({
        success: true,
        orderId: result.orderId,
        amount: result.amount,
        currency: result.currency,
        isFreePlan: result.isFreePlan,
        isUpgrade: result.isUpgrade,
        existingPrice: result.existingPrice,
        newPlanPrice: result.newPlanPrice,
        upgradeAmount: result.upgradeAmount,
        paymentMethod: 'paypal',
        approvalUrl: result.approvalUrl
      });
      
    } catch (error) {
      console.error('Create PayPal upgrade order error:', error);
      res.status(500).json({ 
        error: 'Failed to create PayPal upgrade order', 
        details: error.message 
      });
    }
  };

  /**
   * Refund PayPal payment
   */
  export const refundPayPalController = async (req, res) => {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;
      
      const result = await refundPayPalPayment(orderId, reason);
      
      res.json({
        success: true,
        refund: result
      });
      
    } catch (error) {
      console.error('Refund PayPal payment error:', error);
      res.status(500).json({ 
        error: 'Failed to process PayPal refund', 
        details: error.message 
      });
    }
  };

  /**
   * Sync PayPal order status
   */
  export const syncPayPalOrderStatusController = async (req, res) => {
    try {
      const { orderId } = req.params;
      
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      const result = await syncPayPalOrderStatus(orderId);
      
      res.json({
        success: true,
        message: 'PayPal order status synced successfully',
        result
      });
      
    } catch (error) {
      console.error('Sync PayPal order status error:', error);
      res.status(500).json({ 
        error: 'Failed to sync PayPal order status', 
        details: error.message 
      });
    }
  };

  /**
   * Debug PayPal order status
   */
  export const debugPayPalOrderStatus = async (req, res) => {
    try {
      const { orderId } = req.params;
      
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Get Firestore payment data
      const paymentDoc = await db.collection('payments').doc(orderId).get();
      const firestoreData = paymentDoc.exists ? paymentDoc.data() : null;

      // Get PayPal order data
      let paypalData = null;
      try {
        paypalData = await getPayPalOrderStatus(orderId);
      } catch (paypalError) {
        console.error('PayPal error:', paypalError);
      }

      res.json({
        success: true,
        orderId,
        firestore: firestoreData,
        paypal: paypalData,
        statusMatch: firestoreData?.status === paypalData?.status
      });
      
    } catch (error) {
      console.error('Debug PayPal order status error:', error);
      res.status(500).json({ 
        error: 'Failed to debug PayPal order status', 
        details: error.message 
      });
    }
  };
  