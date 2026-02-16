import express from 'express';
import { 
  createIntent, 
  createCashAppIntent,
  createUpgradeIntent,
  createCashAppUpgradeIntent,
  confirmIntent, 
  confirmCashAppIntent,
  paymentStatus, 
  refund, 
  debugPlans,
  debugPaymentStatus,
  syncPaymentStatus,
  retrievePaymentStatus,
  // PayPal controllers
  createPayPalOrderController,
  capturePayPalOrderController,
  paypalOrderStatusController,
  createPayPalUpgradeOrderController,
  refundPayPalController,
  syncPayPalOrderStatusController,
  debugPayPalOrderStatus
} from '../controllers/payment.controller.js';
import { authenticate, requireAuthenticated } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Apply authentication middleware to all payment routes
router.use(authenticate);
router.use(requireAuthenticated);

router.post('/create-intent', createIntent);
router.post('/create-cashapp-intent', createCashAppIntent);
router.post('/upgrade-intent', createUpgradeIntent);
router.post('/upgrade-cashapp-intent', createCashAppUpgradeIntent);
router.post('/confirm-intent', confirmIntent);
router.post('/confirm-cashapp-intent', confirmCashAppIntent);
router.get('/status/:paymentIntentId', paymentStatus);
router.post('/refund/:paymentIntentId', refund);

// Debug endpoints
router.get('/debug/plans', debugPlans);
router.get('/debug/payment-status/:paymentIntentId', debugPaymentStatus);
router.post('/sync-status/:paymentIntentId', syncPaymentStatus);
router.get('/retrieve-status/:paymentIntentId', retrievePaymentStatus);

// PayPal payment routes
router.post('/create-paypal-order', createPayPalOrderController);
router.post('/capture-paypal-order', capturePayPalOrderController);
router.get('/paypal-status/:orderId', paypalOrderStatusController);
router.post('/paypal-upgrade-order', createPayPalUpgradeOrderController);
router.post('/refund-paypal/:orderId', refundPayPalController);

// PayPal debug endpoints
router.post('/sync-paypal-status/:orderId', syncPayPalOrderStatusController);
router.get('/debug/paypal-order-status/:orderId', debugPayPalOrderStatus);

export default router;
