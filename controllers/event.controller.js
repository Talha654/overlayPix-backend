import { db, } from '../services/firebase.service.js';
import { generateEventQRCode, processPayment } from '../services/event.service.js';
import { createPaymentIntent, processPayment as stripeProcessPayment } from '../services/stripe.service.js';
import Joi from 'joi';
import { DateTime } from 'luxon';
import { r2 } from '../services/r2.service.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import logger from '../services/logger.service.js';
// import { DateTime } from "luxon";
import {
  auditEventCreate,
  auditEventUpdate,
  auditEventToggle,
  auditPayment,
  auditPaymentUpgrade,
  createAuditLog,
  AUDIT_STATUS,
  AUDIT_TYPES
} from '../services/audit.service.js';

import dotenv from 'dotenv';
import { checkStorageExpiration } from './guests.controller.js';
// import { Console } from 'winston/lib/winston/transports/index.js';
dotenv.config();

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

// Combined validation schema
const eventSchema = Joi.object({
  // Event details
  name: Joi.string().required().min(3).max(100),
  type: Joi.string().required(),
  eventDate: Joi.date().required(),
  eventStartTime: Joi.string().required(), // e.g., "14:00"
  eventEndTime: Joi.string().required(),   // e.g., "18:00"
  timeZone: Joi.string().required(),

  // Overlay data: allow overlay to be either an object (file/text/both) or a string (text only)
  overlay: Joi.alternatives().try(
    Joi.object({
      file: Joi.string().base64().optional(),
      text: Joi.string().optional(),
      name: Joi.string().optional()
    }),
    Joi.string() // allow plain text overlay
  ).optional(),

  // Separate overlay name field
  overlayName: Joi.string().allow('').optional(),

  // Branding
  brandColor: Joi.string().allow('').optional(),
  typography: Joi.string().default('Inter'),
  fontStyle: Joi.string().default('normal'),
  fontSize: Joi.number().min(8).max(72).default(16),
  eventPicture: Joi.string().base64().optional(),

  // Plan selection and customization
  planId: Joi.string().required(),
  customPlan: Joi.object({
    guestLimit: Joi.number().min(1).required(),
    photoPool: Joi.number().min(1).required(),
    photosPerGuest: Joi.number().min(1).allow(null).optional(),
    storageDays: Joi.number().min(1).required(),
    permissions: Joi.object({
      canViewGallery: Joi.boolean().default(true),
      canSharePhotos: Joi.boolean().default(true),
      canDownload: Joi.boolean().default(false)
    }).default()
  }).required(),
  finalPrice: Joi.number().min(0).required(),

  // Discount code - allow as top-level field
  discountCode: Joi.alternatives().try(
    Joi.object({
      code: Joi.string().required()
    }),
    Joi.string()
  ).optional(),

  // Payment - conditional validation based on finalPrice
  payment: Joi.when('finalPrice', {
    is: 0,
    then: Joi.object({
      method: Joi.string().optional(),
      paymentIntentId: Joi.string().optional(),
      paypalOrderId: Joi.string().optional(),
      discountCode: Joi.string().optional()
    }).optional(),
    otherwise: Joi.object({
      method: Joi.string().optional(),
      paymentIntentId: Joi.string().when('method', {
        is: 'paypal',
        then: Joi.optional(),
        is: 'revenuecat',
        then: Joi.optional(),
        otherwise: Joi.required()
      }),
      paypalOrderId: Joi.string().when('method', {
        is: 'paypal',
        then: Joi.required(),
        otherwise: Joi.optional()
      }),
      transactionId: Joi.string().when('method', {
        is: 'revenuecat',
        then: Joi.required(),
        otherwise: Joi.optional()
      }),
      productId: Joi.string().optional(),
      platform: Joi.string().optional(),
      customerInfo: Joi.object().optional(),
      discountCode: Joi.string().optional()
    }).required()
  })
});

export const createCompleteEvent = async (req, res) => {
  // console.log(req);
  console.log('discountCode', req.body.discountCode);
  console.log('eventdate', req.body.eventDate);
  const user = req.user;
  // Parse customPlan and payment if they are strings (for multipart/form-data)
  if (typeof req.body.customPlan === 'string') {
    try {
      req.body.customPlan = JSON.parse(req.body.customPlan);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid customPlan JSON' });
    }
  }
  if (typeof req.body.payment === 'string') {
    try {
      req.body.payment = JSON.parse(req.body.payment);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payment JSON' });
    }
  }
  if (typeof req.body.discountCode === 'string') {
    try {
      req.body.discountCode = JSON.parse(req.body.discountCode);
    } catch (e) {
      // If it's not JSON, treat it as a simple string
      req.body.discountCode = { code: req.body.discountCode };
    }
  }
  // Validate input (for non-file fields)
  const { error, value } = eventSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  const data = value;

  try {
    // Start Firestore batch
    const batch = db.batch();
    const eventsRef = db.collection('events');
    const eventId = eventsRef.doc().id;

    // 1. Process overlay image (from req.files)
    let overlayId = null;
    let overlayUrl = null;
    // console.log('data.overlay', data.overlay);
    // console.log('typeof data.overlay', typeof data.overlay);
    // console.log('req.files', req.files);
    // console.log('req.files.overlay', req.files.overlay);
    // console.log('req.files.overlay[0]', req.files.overlay[0]);

    if (typeof data.overlay === 'string') {
      // CASE 1: ID from frontend
      const existingOverlayDoc = await db.collection('adminOverlays').doc(data.overlay).get();

      if (!existingOverlayDoc.exists) {
        return res.status(404).json({ error: 'Overlay not found' });
      }

      const existingOverlay = existingOverlayDoc.data();
      overlayId = data.overlay;
      overlayUrl = existingOverlay.url || null;

    }
    else if (req.files && req.files.overlay && req.files.overlay[0]) {


      const overlayRef = db.collection('userOverlays').doc();
      overlayId = overlayRef.id;
      const overlayFile = req.files.overlay[0];
      const overlayFileName = `useroverlays/${overlayId}/overlay-${Date.now()}.png`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: overlayFileName,
        Body: overlayFile.buffer,
        ContentType: overlayFile.mimetype,
      }));
      overlayUrl = getR2PublicUrl(overlayFileName);
      const overlayData = {
        ...(data.overlay?.name && { name: data.overlay.name }),
        ...(overlayUrl && { url: overlayUrl }),
        createdAt: new Date(),
        uploadedBy: user?.uid || null // Save uid of user who uploads the url
      };
      batch.set(overlayRef, overlayData);
    }

    // 2. Upload event picture (from req.files) and save to 'photos' collection
    let eventPictureUrl = '';
    if (req.files && req.files.eventPicture && req.files.eventPicture[0]) {
      const eventPictureFile = req.files.eventPicture[0];
      const fileName = `events/${eventId}/banner-${Date.now()}.png`;
      const result = await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: fileName,
        Body: eventPictureFile.buffer,
        ContentType: eventPictureFile.mimetype,
      }));
      // console.log('result', result);
      eventPictureUrl = getR2PublicUrl(fileName);

      // Save event photo metadata to 'photos' collection
      const photoRef = db.collection('eventPhotos').doc();
      const photoData = {
        eventId: eventId,
        url: eventPictureUrl,
        uploadedBy: user?.uid || null,
        type: 'eventPicture',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      batch.set(photoRef, photoData);
    }

    // 3. Fetch the base plan and perform comprehensive validation
    const { planId, customPlan, finalPrice, eventStartTime, eventEndTime, eventDate } = data;

    console.log('eventDate', data.eventDate);

    let plan; // Declare plan here so it's accessible in both branches
    let basePlanName; // Declare basePlanName here

    const isRevenueCat = data.payment?.method === 'revenuecat';
    console.log('Is RevenueCat?', isRevenueCat);
    console.log('Payment Method:', data.payment?.method);

    if (isRevenueCat) {
      console.log('RevenueCat purchase detected, skipping DB plan lookup. Using frontend config.');
      // Create a "virtual" plan based on the customPlan to allow validation to pass
      // We set minimums to 0 or equal to customPlan to ensure "base limits" don't fail validation
      // The security check is strictly: Does (customPlan features * unit prices) == finalPrice?
      // ACTION: We will fetch the 'Starter Pass' (or closest equivalent) just for unit prices?
      // OR we can't validate price logic complexity on backend if we don't have the "rules" (unit prices).
      // USER REQUEST: "configuartion send from frontend"
      // If we strictly follow this, we assume the frontend sends a `finalPrice` and we just verify
      // that the USER PAID that `finalPrice` via RevenueCat.
      // So we construct a dummy plan that allows the `computeAmountFromPlan` or we SKIP
      // `computeAmountFromPlan` for RC and just verify payment amount matches `finalPrice`.
      plan = {
        name: planId, // Use the product ID as the name
        price: 0, // Base price 0, everything is add-on or base package price?
        // actually, for RC, the "plan" implies the base configuration.
        // If we want to validate price, we need to know the unit costs.
        // If we trust frontend entirely, we just check if paid amount == finalPrice.
        // BUT `computeAmountFromPlan` needs a plan object with unit prices.
        guestLimit: 0,
        photoPool: 0,
        guestLimitIncreasePricePerGuest: 0, // We can't validate unit math without DB rules
        photoPoolLimitIncreasePricePerPhoto: 0,
        storageOptions: [{ days: customPlan.storageDays, price: 0 }]
      };
      basePlanName = planId;

    } else {
      console.log('Doing standard DB plan lookup for planId:', planId);
      // Normal Flow: Fetch the plan by planId from DB
      const planDoc = await db.collection('pricingPlans').doc(planId).get();

      if (!planDoc.exists) {
        return res.status(400).json({ error: 'Invalid planId' });
      }
      plan = planDoc.data();
      basePlanName = plan.name || '';
    }

    // 3.1. Server-side price calculation and validation
    let serverCalculatedCents;
    let originalPrice = 0;
    let discountedPrice = 0;
    let discountResult = null;

    try {
      const isRevenueCat = data.payment?.method === 'revenuecat';

      if (isRevenueCat) {
        // Trusted Frontend Config Mode for RevenueCat
        // We trust the structure but ideally would verify the math if we knew unit prices.
        // Since we don't, we assume the frontend calculated price is the 'originalPrice'.
        serverCalculatedCents = Math.round(finalPrice * 100);
        originalPrice = finalPrice;
        discountedPrice = finalPrice;
      } else {
        // Standard Server-Side Calculation
        serverCalculatedCents = computeAmountFromPlan(plan, customPlan);
        originalPrice = serverCalculatedCents / 100;
        discountedPrice = originalPrice;
      }

      const clientCents = Math.round(finalPrice * 100);

      // 3.1.1. Handle discount code if provided - validate and apply on backend
      if (data.discountCode && data.discountCode.code) {
        console.log('Validating discount code on backend in createcompleteevent:', {
          code: data.discountCode.code,
          originalPrice,
          finalPrice
        });

        try {
          const { validateDiscountCode } = await import('../services/discountcode.service.js');

          // Validate the discount code
          const validationResult = await validateDiscountCode(data.discountCode.code);

          if (!validationResult.isValid) {
            return res.status(400).json({
              error: 'Invalid discount code',
              details: validationResult.error
            });
          }

          // Calculate the discounted price based on the discount code
          const discountCode = validationResult.discountCode;
          let discountAmount = 0;

          if (discountCode.discountType === 'percentage') {
            discountAmount = (originalPrice * discountCode.discountValue) / 100;
          } else if (discountCode.discountType === 'fixed') {
            discountAmount = discountCode.discountValue;
          }

          // Ensure discount doesn't exceed original price
          discountAmount = Math.min(discountAmount, originalPrice);

          // Calculate the expected final price after discount
          discountedPrice = originalPrice - discountAmount;

          console.log('Discount code validation result in createcompleteevent:', {
            code: data.discountCode.code,
            discountType: discountCode.discountType,
            discountValue: discountCode.discountValue,
            discountAmount,
            originalPrice,
            expectedFinalPrice: discountedPrice,
            clientFinalPrice: finalPrice
          });

          // Store discount result for later use
          discountResult = {
            discountCode: {
              discountType: discountCode.discountType,
              discountValue: discountCode.discountValue
            },
            discountAmount: discountAmount,
            finalAmount: discountedPrice
          };

          console.log('discountResult from in createcompleteevent:', discountResult);

        } catch (discountError) {
          console.error('Discount code validation error:', discountError);
          return res.status(400).json({
            error: 'Failed to validate discount code',
            details: discountError.message
          });
        }
      }

      // Update serverCalculatedCents to match the final price (with discount applied)
      serverCalculatedCents = Math.round(discountedPrice * 100);

      // Validate client price against server calculation
      if (clientCents !== serverCalculatedCents) {
        // If no discount code provided, accept client's price as final price
        if (!data.discountCode?.code) {
          console.log('No discount code provided in event creation, using client price as final price:', {
            userId: user.uid,
            planId,
            clientCents,
            serverCalculatedCents,
            originalPrice,
            clientPrice: finalPrice
          });
          discountedPrice = finalPrice; // Use client's price
          serverCalculatedCents = Math.round(discountedPrice * 100);
        } else {
          console.warn('Client finalPrice mismatch detected in event creation', {
            userId: user.uid,
            planId,
            clientCents,
            serverCalculatedCents,
            originalPrice,
            discountedPrice,
            discountCode: data.discountCode?.code,
            discountAmount: discountResult?.discountAmount,
            customPlan,
            plan: {
              price: plan.price,
              guestLimit: plan.guestLimit,
              photoPool: plan.photoPool,
              storageOptions: plan.storageOptions
            }
          });
          return res.status(400).json({
            error: 'Price validation failed - client and server prices do not match',
            details: {
              clientPrice: finalPrice,
              serverPrice: serverCalculatedCents / 100,
              originalPrice,
              discountApplied: discountResult?.discountAmount || 0,
              difference: Math.abs(clientCents - serverCalculatedCents) / 100
            }
          });
        }
      }
    } catch (priceError) {
      console.error('Price calculation error:', priceError);
      return res.status(400).json({
        error: 'Failed to calculate price',
        details: priceError.message
      });
    }

    // 3.2. Validate plan limits and constraints
    // For RevenueCat, we skip strict valid storage days check if we're generating phantom plan
    const validationErrors = [];


    // Validate storageDays is allowed for this plan
    if (!isRevenueCat) {
      const allowedStorageDays = Array.isArray(plan.storageOptions)
        ? plan.storageOptions.map(opt => opt.days)
        : [];
      if (!allowedStorageDays.includes(customPlan.storageDays)) {
        validationErrors.push(`Invalid storage duration (${customPlan.storageDays} days) for this plan. Allowed: ${allowedStorageDays.join(', ')}`);
      }

      // Validate guest limit constraints
      if (customPlan.guestLimit < plan.guestLimit) {
        validationErrors.push(`Guest limit (${customPlan.guestLimit}) cannot be less than plan minimum (${plan.guestLimit})`);
      }

      // Validate photo pool constraints
      if (customPlan.photoPool < plan.photoPool) {
        validationErrors.push(`Photo pool (${customPlan.photoPool}) cannot be less than plan minimum (${plan.photoPool})`);
      }
    }

    // Validate minimum values (Common for all)
    if (customPlan.guestLimit < 1) validationErrors.push('Guest limit must be at least 1');
    if (customPlan.photoPool < 1) validationErrors.push('Photo pool must be at least 1');
    // if (customPlan.photosPerGuest < 1) validationErrors.push('Photos per guest must be at least 1');
    if (customPlan.storageDays < 1) validationErrors.push('Storage days must be at least 1');

    // Validate maximum reasonable limits (prevent abuse)
    if (customPlan.guestLimit > 10000) validationErrors.push('Guest limit cannot exceed 10,000');
    if (customPlan.photoPool > 100000) validationErrors.push('Photo pool cannot exceed 100,000');
    if (customPlan.photosPerGuest > 1000) validationErrors.push('Photos per guest cannot exceed 1,000');
    if (customPlan.storageDays > 3650) validationErrors.push('Storage days cannot exceed 10 years');

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Plan validation failed',
        details: validationErrors
      });
    }
    // 3.3. Validate event timing

    // 1. Parse the eventDate (full ISO string)
    let date = DateTime.fromJSDate(eventDate, { zone: 'utc' });
    console.log('eventdate', date);
    if (!date.isValid) {
      return res.status(400).json({ error: 'Invalid eventDate' });
    }


    const start = DateTime.fromFormat(eventStartTime, 'HH:mm');
    const end = DateTime.fromFormat(eventEndTime, 'HH:mm');
    if (!start.isValid || !end.isValid) {
      return res.status(400).json({ error: 'Invalid start or end time format (expected HH:mm)' });
    }
    console.log('start time', start);
    console.log('end time', end);
    let diff = end.diff(start, 'hours').hours;
    console.log('Event difference (hours):', diff);
    if (diff < 0) diff += 24; // handle overnight events
    console.log('Normalized event difference (hours):', diff);
    if (diff > 24) {
      return res.status(400).json({ error: 'Event end time cannot be more than 24 hours after start time' });
    }

    // 3. Merge start time into eventDate
    const eventStartDateTime = date.set({
      hour: start.hour,
      minute: start.minute,
      second: 0,
      millisecond: 0
    });

    let eventEndDateTime = date.set({
      hour: end.hour,
      minute: end.minute,
      second: 0,
      millisecond: 0
    });

    console.log('eventEndDateTime:', eventEndDateTime.toISO());

    if (diff < 24 && diff > 23.75) {
      eventEndDateTime = eventEndDateTime.plus({ days: 1 });
      console.log('Adjusted eventEndDateTime for overnight event:', eventEndDateTime.toISO());
    }

    // Convert Luxon DateTime -> JS Date
    const eventStartDate = eventStartDateTime.toJSDate();
    const eventEndDate = eventEndDateTime.toJSDate();

    // 4. Verify payment intent exists and is valid
    let paymentResult;
    try {
      // If finalPrice is 0, payment is not required
      if (data.finalPrice === 0) {
        paymentResult = {
          success: true,
          paymentIntentId: null,
          status: 'free_plan',
          amount: 0,
          isFreePlan: true
        };
      } else {
        // Determine payment method and ID
        const paymentMethod = data.payment.method || 'stripe';
        let paymentId;
        if (paymentMethod === 'paypal') {
          paymentId = data.payment.paypalOrderId;
        } else if (paymentMethod === 'revenuecat') {
          paymentId = data.payment.transactionId;
        } else {
          paymentId = data.payment.paymentIntentId;
        }

        console.log('Payment data:', {
          userId: user.uid,
          planId,
          customPlan,
          finalPrice: data.finalPrice,
          paymentMethod,
          paymentId
        });

        if (paymentMethod === 'revenuecat') {
          const { verifySubscription } = await import('../services/revenuecat.service.js');
          // Extract productId if available
          const productId = data.payment.productId;
          const verification = await verifySubscription(paymentId, productId);


          if (!verification.success) {
            return res.status(400).json({
              error: 'Payment verification failed',
              details: verification
            });
          }

          // REPLAY ATTACK PROTECTION FOR ONE-TIME PRODUCTS
          let revenueCatTransactionId = null;
          if (verification.validConsumablePurchase) {
            revenueCatTransactionId = verification.validConsumablePurchase.store_transaction_identifier;

            if (revenueCatTransactionId) {
              // Check if this transaction has already been used
              const existingEventWithTransaction = await db.collection('events')
                .where('payment.revenueCatTransactionId', '==', revenueCatTransactionId)
                .get();

              if (!existingEventWithTransaction.empty) {
                console.warn(`Replay attack prevented! Transaction ${revenueCatTransactionId} already used.`);
                return res.status(400).json({
                  error: 'Payment verification failed: Transaction already used',
                  details: 'This purchase has already been used to create an event.'
                });
              }
              console.log(`Transaction ${revenueCatTransactionId} is fresh. Proceeding.`);
            }
          }

          paymentResult = {
            success: true,
            paymentIntentId: paymentId,
            status: 'completed',
            amount: data.finalPrice,
            isFreePlan: false,
            paymentMethod: 'revenuecat',
            provider: data.payment.platform || null,
            revenueCatTransactionId: revenueCatTransactionId || null // Store the transaction ID to prevent reuse
          };
        } else {
          // Get payment record to verify it exists and belongs to this user
          const paymentDoc = await db.collection('payments').doc(paymentId).get();

          if (!paymentDoc.exists) {
            return res.status(400).json({
              error: `Payment ${paymentMethod === 'paypal' ? 'order' : 'intent'} not found`
            });
          }

          const paymentData = paymentDoc.data();
          console.log('paymentData', paymentData);
          console.log('Payment verification details:', {
            userId: user.uid,
            paymentUserId: paymentData.userId,
            paymentStatus: paymentData.status,
            isFreePlan: paymentData.isFreePlan,
            totalAmount: paymentData.totalAmount,
            finalPrice: data.finalPrice,
            paymentMethod,
            paymentId
          });

          // Verify payment belongs to this user
          if (paymentData.userId !== user.uid) {
            return res.status(403).json({
              error: `Payment ${paymentMethod === 'paypal' ? 'order' : 'intent'} does not belong to this user`
            });
          }

          // Sync payment status from payment provider to ensure we have the latest status
          let currentPaymentStatus = paymentData.status;
          try {
            if (paymentMethod === 'paypal') {
              const { getPayPalOrderStatus } = await import('../services/paypal.service.js');
              const paypalStatus = await getPayPalOrderStatus(paymentId);
              currentPaymentStatus = paypalStatus.status;
              console.log('Synced payment status from PayPal:', {
                firestoreStatus: paymentData.status,
                paypalStatus: currentPaymentStatus
              });
            } else {
              const { getPaymentStatus } = await import('../services/stripe.service.js');
              const stripeStatus = await getPaymentStatus(paymentId);
              currentPaymentStatus = stripeStatus.status;
              console.log('Synced payment status from Stripe:', {
                firestoreStatus: paymentData.status,
                stripeStatus: currentPaymentStatus
              });
            }
          } catch (syncError) {
            console.warn(`Failed to sync payment status from ${paymentMethod}:`, syncError);
            // Continue with Firestore status
          }

          // Verify payment amount matches the calculated price (with discount applied)
          const paymentAmountCents = Math.round(paymentData.totalAmount * 100);
          if (paymentAmountCents !== serverCalculatedCents) {
            // If no discount code provided, accept payment amount as final price
            if (!data.discountCode?.code) {
              console.log('No discount code provided, payment amount validation passed:', {
                userId: user.uid,
                planId,
                paymentAmountCents,
                serverCalculatedCents,
                originalPrice,
                paymentAmount: paymentData.totalAmount
              });
              // Update server calculated cents to match payment amount
              serverCalculatedCents = paymentAmountCents;
              discountedPrice = paymentData.totalAmount;
            } else {
              console.warn('Payment amount mismatch detected', {
                userId: user.uid,
                planId,
                paymentAmountCents,
                serverCalculatedCents,
                originalPrice,
                discountedPrice,
                discountCode: data.discountCode?.code,
                discountAmount: discountResult?.discountAmount,
                paymentId
              });
              return res.status(400).json({
                error: 'Payment amount does not match calculated price',
                details: {
                  paymentAmount: paymentData.totalAmount,
                  calculatedPrice: serverCalculatedCents / 100,
                  originalPrice,
                  discountApplied: discountResult?.discountAmount || 0,
                  difference: Math.abs(paymentAmountCents - serverCalculatedCents) / 100
                }
              });
            }
          }

          // Verify payment is in correct status
          // For PayPal, status is 'COMPLETED', for Stripe it's 'succeeded'
          const isPaymentCompleted = paymentMethod === 'paypal'
            ? (currentPaymentStatus === 'COMPLETED' || currentPaymentStatus === 'APPROVED')
            : currentPaymentStatus === 'succeeded';

          if (!isPaymentCompleted && !paymentData.isFreePlan) {
            return res.status(400).json({
              error: 'Payment not completed. Please complete payment first.',
              details: {
                currentStatus: currentPaymentStatus,
                paymentMethod
              }
            });
          }

          paymentResult = {
            success: true,
            paymentIntentId: paymentId,
            status: currentPaymentStatus,
            amount: paymentData.totalAmount,
            isFreePlan: paymentData.isFreePlan || false,
            paymentMethod
          };
        }
      }

    } catch (paymentError) {
      console.error('Payment verification error:', paymentError);
      return res.status(400).json({
        error: 'Payment verification failed',
        details: paymentError.message
      });
    }

    // 4.1. Apply discount code usage tracking
    if (data.discountCode && data.discountCode.code) {
      console.log('Attempting to apply discount code:', {
        code: data.discountCode.code,
        originalPrice,
        eventId
      });

      try {
        const { applyDiscountCode } = await import('../services/discountcode.service.js');

        // Generate order ID for this event
        const orderId = `event_${eventId}`;

        const applyResult = await applyDiscountCode(
          data.discountCode.code,
          originalPrice,
          eventId,
          user.uid
        );

        console.log('Discount code apply result:', applyResult);

        if (!applyResult.success) {
          console.warn('Failed to track discount code usage:', applyResult.error);
          // Don't fail the event creation, just log the warning
        } else {
          console.log('Discount code usage tracked successfully:', {
            code: data.discountCode.code,
            eventId,
            discountAmount: applyResult.discountAmount
          });

          // Update discountResult for response
          discountResult = {
            discountCode: {
              discountType: applyResult.discountCode?.discountType,
              discountValue: applyResult.discountCode?.discountValue
            },
            discountAmount: applyResult.discountAmount,
            finalAmount: finalPrice
          };
        }

      } catch (applyError) {
        // Don't fail the event creation, just log the warning
      }
    } else {
      console.log('No discount code provided or discount code is empty');
    }
    // 6. Generate share code and QR code
    const shareCode = generateShareCode();
    const qrCodeUrl = await generateEventQRCode(shareCode, data.name);


    // console.log('discountCode in createcompleteevent:', discountCode);
    // console.log('discountResult.discountAmount in createcompleteevent:', discountResult.discountAmount);
    // console.log('discountResult.finalAmount in createcompleteevent:', discountResult.finalAmount);


    // 7. Create event document
    // Avoid undefined Firestore values: set overlayUrl to null if not present
    console.log('eventDate in createcompleteevent:', eventDate);
    const eventData = {
      eventId,
      userId: user.uid,
      name: data.name,
      type: data.type,
      eventDate: eventStartDate,  // Store JS Date object
      eventStartTime,
      eventEndTime,
      eventEndDate,
      timeZone: data.timeZone,
      brandColor: data.brandColor,
      typography: data.typography,
      fontStyle: data.fontStyle,
      fontSize: data.fontSize,
      eventPictureUrl,
      overlayId,
      overlayUrl: typeof overlayUrl === 'undefined' ? null : overlayUrl,
      overlayName: data.overlayName || null,
      planId,
      basePlanName, // Add basePlanName to event document
      customPlan,
      finalPrice,
      // Add discount information
      originalPrice: originalPrice || 0,
      discountCode: data.discountCode?.code || null,
      discountAmount: data.discountCode?.code ? (discountResult?.discountAmount || 0) : (originalPrice - finalPrice),
      discountType: discountResult?.discountCode?.discountType || null,
      qrCodeUrl,
      shareCode,
      status: 'active',

      createdAt: new Date(),
      payment: paymentResult || null
    };

    console.log('raw saved value:', eventData.eventDate);
    console.log('typeof saved value:', typeof eventData.eventDate);
    batch.set(eventsRef.doc(eventId), eventData);

    console.log('discount code in evenData', eventData.discountCode)
    console.log('discount Amount in evenData', eventData.discountAmount)
    console.log('discount Type in evenData', eventData.discountType)

    // 8. Commit all operations
    await batch.commit();

    // Audit log: Event creation
    await auditEventCreate(
      user.uid,
      user.email,
      eventId,
      data.name,
      planId,
      AUDIT_STATUS.SUCCESS,
      req
    );

    // Audit log: Payment processing
    if (paymentResult.paymentIntentId) {
      await auditPayment(
        user.uid,
        user.email,
        eventId,
        data.name,
        paymentResult.amount,
        planId,
        AUDIT_STATUS.SUCCESS,
        req
      );
    }

    // Log successful event creation with security details
    logger.info({
      message: 'Event created successfully',
      userId: user.uid,
      eventId,
      eventName: data.name,
      planId,
      finalPrice: data.finalPrice,
      paymentIntentId: paymentResult.paymentIntentId,
      action: 'Event created',
      status: 'success',
      security: {
        priceValidated: true,
        planValidated: true,
        paymentVerified: true,
        userAuthenticated: true
      },
      timestamp: new Date().toISOString()
    });
    res.status(201).json({
      success: true,
      event: eventData,
      payment: {
        id: paymentResult.paymentIntentId,
        status: paymentResult.status,
        amount: paymentResult.amount
      },
      discount: data.discountCode?.code && discountResult ? {
        code: data.discountCode.code,
        type: discountResult.discountCode?.discountType || null,
        value: discountResult.discountCode?.discountValue || null,
        amount: discountResult.discountAmount || 0,
        originalPrice: originalPrice || 0,
        finalPrice: finalPrice || 0
      } : (originalPrice > finalPrice ? {
        code: null,
        type: 'client_applied',
        value: null,
        amount: originalPrice - finalPrice,
        originalPrice: originalPrice || 0,
        finalPrice: finalPrice || 0
      } : null),
      shareCode: eventData.shareCode,
      eventPictureUrl,
      overlayUrl
    });
  } catch (error) {
    // Audit log: Event creation failed
    if (user?.uid) {
      await auditEventCreate(
        user.uid,
        user.email,
        null,
        req.body.name || 'Unknown Event',
        req.body.planId,
        AUDIT_STATUS.ERROR,
        req
      );
    }

    logger.error({
      message: 'Event creation failed',
      userId: user?.uid,
      error: error.message,
      stack: error.stack,
      status: 'error',
      timestamp: new Date().toISOString()
    });
    console.error('Event Creation Error:', error);
    res.status(500).json({ error: 'Failed to create event', details: error.message });
  }
};

// Get dashboard stats for the logged-in user

// import { DateTime } from 'luxon';

export const getEventDashboard = async (req, res) => {
  try {
    const userId = req.user.uid;

    // 1️⃣ Fetch events list (paginated if needed)
    const eventsSnap = await db
      .collection("events")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const events = eventsSnap.docs.map(doc => ({
      ...doc.data(),
      eventId: doc.id
    }));

    if (events.length === 0) {
      return res.json({
        totalEvents: 0,
        activeEvents: 0,
        totalGuests: 0,
        totalPhotos: 0,
        events: []
      });
    }

    // 2️⃣ OPTIMIZED: Use batch queries instead of individual count queries
    const eventIds = events.map(e => e.eventId);

    // Helper function to chunk arrays (Firestore IN operator limit is 30)
    const chunkArray = (array, chunkSize) => {
      const chunks = [];
      for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
      }
      return chunks;
    };

    // Process eventIds in chunks of 30
    const eventIdChunks = chunkArray(eventIds, 30);

    // Fetch all guests and photos in chunks
    const [allGuestsSnapshots, allPhotosSnapshots] = await Promise.all([
      Promise.all(
        eventIdChunks.map(chunk =>
          db.collection("guests").where("eventId", "in", chunk).get()
        )
      ),
      Promise.all(
        eventIdChunks.map(chunk =>
          db.collection("photos").where("eventId", "in", chunk).get()
        )
      )
    ]);

    // 3️⃣ Count in memory
    const guestCountMap = {};
    const photoCountMap = {};

    allGuestsSnapshots.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const eventId = doc.data().eventId;
        guestCountMap[eventId] = (guestCountMap[eventId] || 0) + 1;
      });
    });

    allPhotosSnapshots.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const eventId = doc.data().eventId;
        photoCountMap[eventId] = (photoCountMap[eventId] || 0) + 1;
      });
    });

    // 4️⃣ Attach counts to events
    events.forEach((event) => {
      event.guestsCount = guestCountMap[event.eventId] || 0;
      event.photosCount = photoCountMap[event.eventId] || 0;
    });

    // 5️⃣ Calculate totals
    const totalEvents = events.length;
    // We'll recalculate status below, so don't use e.status here for activeEvents
    let activeEvents = 0;
    const totalGuests = Object.values(guestCountMap).reduce((sum, count) => sum + count, 0);
    const totalPhotos = Object.values(photoCountMap).reduce((sum, count) => sum + count, 0);

    // 6️⃣ Format for dashboard, and determine status (active/expired) based on event date
    const eventCards = events.map(e => {
      let formattedDate = e.eventDate;
      let status = e.status || "active"; // fallback to "active" if not set
      console.log('Event Status', e.status);
      console.log('Raw eventenddate value:', e.eventEndDate);
      console.log('Type of eventEndDate:', typeof e.eventEndDate);
      console.log('Raw eventDate value:', e.eventDate);
      console.log('Type of eventDate:', typeof e.eventDate);
      console.log('Event timeZone:', e.timeZone);
      // --- Calculate event status (active/expired) ---
      let eventDateISO;
      if (e.eventDate && typeof e.eventDate === 'object' && typeof e.eventDate.toDate === 'function') {
        // Firestore Timestamp object
        eventDateISO = e.eventDate.toDate().toISOString();
        formattedDate = DateTime.fromJSDate(e.eventDate.toDate(), { zone: 'utc' || 'local' })
          .toFormat("yyyy-MM-dd HH:mm:ssZZ");
        console.log('Converted Firestore Timestamp to ISO:', eventDateISO);
        console.log('Formatted date from Firestore Timestamp:', formattedDate);
      } else if (e.eventDate && !isNaN(Date.parse(e.eventDate))) {
        // ISO string or date string
        eventDateISO = new Date(e.eventDate).toISOString();
        formattedDate = DateTime.fromISO(eventDateISO, { zone: 'utc' || 'local' })
          .toFormat("yyyy-MM-dd HH:mm:ssZZ");
        console.log('Parsed eventDate string to ISO:', eventDateISO);
        console.log('Formatted date from eventDate string:', formattedDate);
      } else if (e.eventDate && typeof e.eventDate._seconds === 'number') {
        // Possibly a plain Timestamp-like object
        eventDateISO = new Date(e.eventDate._seconds * 1000).toISOString();
        formattedDate = DateTime.fromISO(eventDateISO, { zone: 'utc' || 'local' })
          .toFormat("yyyy-MM-dd HH:mm:ssZZ");
        console.log('Converted plain Timestamp-like object to ISO:', eventDateISO);
        console.log('Formatted date from plain Timestamp-like object:', formattedDate);
      } else {
        eventDateISO = null;
        formattedDate = null;
      }

      // Default to 23:59 if no end time
      let endTimeStr = e.eventEndTime && typeof e.eventEndTime === 'string'
        ? e.eventEndTime
        : '23:59';

      // Parse hours and minutes
      let [hours, minutes] = endTimeStr.split(':').map(Number);
      if (isNaN(hours) || isNaN(minutes)) {
        hours = 23;
        minutes = 59;
      }

      // Use luxon to combine date and time in the event's time zone
      let eventEndDateTime;
      if (eventDateISO) {
        let eventDateObj = DateTime.fromISO(eventDateISO, { zone: 'utc' || 'local' });
        eventEndDateTime = eventDateObj.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
        console.log('EventDateObj in expire logic:', eventDateObj);
        console.log('Computed eventEndDateTime in expire logic:', eventEndDateTime);

        // Now, compare current time in the event's time zone
        const nowInEventTZ = DateTime.now().setZone('utc' || 'local');
        const timeNow = nowInEventTZ.ts - 14400000; // Adjusting for -4 hours (example)
        console.log('Current time (ts):', timeNow);
        console.log('Current time in event time zone:', nowInEventTZ);
        console.log('Event end time in event time zone:', eventEndDateTime.ts);
        console.log('eventEndDateTime', eventEndDateTime);
        if (timeNow > eventEndDateTime.ts) {
          // if (e.updatedBy !== 'admin') {
          //   console.log(`updatedBy is ${e.updatedBy}, updating event status to expired for eventId: ${e.eventId}`);
          //   db.collection("events").doc(e.eventId).update({ status: "expired" });
          // }
          status = "active";
        } else {
          status = "active";
        }
      }
      console.log('Final event status:', e.status);

      if (!formattedDate && e.eventDate && e.eventDate.toDate) {
        formattedDate = e.eventDate.toDate().toISOString();
      }
      const nowInEventTZ = DateTime.now().setZone('America/New_York');
      if (nowInEventTZ > e.eventEndDate?.toDate()) {
        console.log('Event is expired based on current time:', nowInEventTZ.toISO());
        console.log('Event is expired based on eventEndDate:', e.eventEndDate?.toDate());
      } else {
        console.log('Event is still active based on current time:', nowInEventTZ.toISO());
        console.log('Event is still active based on eventEndDate:', e.eventEndDate?.toDate());
      }
      if (status === "active") activeEvents += 1;

      // --- Calculate storageExpired ---
      // storageExpired = true if now > (eventDate + storageDays)
      let storageExpired = false;
      let storageDays = null;
      let storageDuration = null;
      // Try to get storageDays from customPlan or plan
      if (e.customPlan && typeof e.customPlan.storageDays === "number") {
        storageDays = e.customPlan.storageDays;
        storageDuration = e.customPlan.storageDays;
      } else if (e.plan && typeof e.plan.storageDays === "number") {
        storageDays = e.plan.storageDays;
        storageDuration = e.plan.storageDays;
      }

      if (eventDateISO && storageDays != null) {
        // Add storageDays to eventDateISO
        // Use luxon for time zone correctness
        let eventDateObj = DateTime.fromISO(eventDateISO, { zone: 'utc' || 'local' });
        let storageExpiryDate = eventDateObj.plus({ days: storageDays });
        const nowInEventTZ = DateTime.now().setZone('utc' || 'local');
        storageExpired = nowInEventTZ > storageExpiryDate;
      }

      // Display storageDays as storageDays and also as storageDuration for backward compatibility
      return {
        eventId: e.eventId,
        name: e.name,
        type: e.type,
        status: e.status || status,
        date: formattedDate,
        photosCount: e.photosCount,
        guestsCount: e.guestsCount,
        storageDays: storageDays,
        storageDuration: storageDuration, // <-- keep storageDuration for compatibility
        storageExpired: !!storageExpired
      };
    });

    res.json({
      totalEvents,
      activeEvents,
      totalGuests,
      totalPhotos,
      events: eventCards
    });

  } catch (error) {
    console.error("Dashboard Error:", error);

    // Audit log: Get event dashboard failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: null,
      eventName: null,
      action: 'Get event dashboard failed',
      details: {
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: error.message });
  }
};

// Get all events for the logged-in user
export const getEvents = async (req, res) => {
  try {
    const userId = req.user.uid;
    const eventsSnap = await db.collection('events').where('userId', '==', userId).get();
    const events = eventsSnap.docs.map(doc => doc.data());
    res.json(events);
  } catch (error) {
    console.error('Get Events Error:', error);

    // Audit log: Get events failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: null,
      eventName: null,
      action: 'Get events failed',
      details: {
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

// Get event by ID
export const getEventById = async (req, res) => {
  try {
    const eventId = req.params.id;
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) return res.status(404).json({ error: 'Event not found' });
    res.json(eventDoc.data());
  } catch (error) {
    console.error('Get Event By ID Error:', error);

    // Audit log: Get event by ID failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.id,
      eventName: null,
      action: 'Get event by ID failed',
      details: {
        eventId: req.params.id,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

// Update event by ID
export const updateEvent = async (req, res) => {
  try {
    const eventId = req.params.id;
    const user = req.user;

    if (typeof req.body.customPlan === 'string') {
      try {
        req.body.customPlan = JSON.parse(req.body.customPlan);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid customPlan JSON' });
      }
    }
    const rawUpdateData = req.body || {};

    console.log('eventId', eventId);

    console.log('rawUpdateData', rawUpdateData);

    // Convert to plain object to ensure hasOwnProperty works
    const updateData = { ...rawUpdateData };

    // Check if updateData is empty (no fields to update)
    if (
      Object.keys(updateData).length === 0 &&
      (!req.files || Object.keys(req.files).length === 0)
    ) {
      return res.status(400).json({
        error: 'No update data provided',
        debug: {
          bodyType: typeof req.body,
          bodyKeys: req.body ? Object.keys(req.body) : 'undefined',
          contentType: req.headers['content-type'],
          hasFiles: !!req.files,
        },
      });
    }

    // Verify event exists and belongs to the user
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // console.log('Update Event Request Details:', {
    //   eventId,
    //   userId: user.uid,
    //   contentType: req.headers['content-type'],
    //   bodyType: typeof req.body,
    //   bodyKeys: req.body ? Object.keys(req.body) : 'undefined',
    //   bodyLength: req.body ? Object.keys(req.body).length : 0,
    //   bodyValue: req.body,
    //   updateData: Object.keys(updateData),
    //   hasFiles: !!req.files,
    //   fileKeys: req.files ? Object.keys(req.files) : [],
    //   rawBody: req.body,
    //   files: req.files
    // });

    const existingEvent = eventDoc.data();
    if (existingEvent.userId !== user.uid) {
      return res.status(403).json({ error: 'Access denied. You can only update your own events.' });
    }

    // SECURITY CHECK: For PATCH requests, block any restricted fields that are present
    const restrictedFields = [
      'planId', 'finalPrice', 'basePlanName',
      'payment', 'qrCodeUrl', 'shareCode', 'status', 'userId',
      'createdAt', 'stripeCustomerId', 'stripePaymentIntentId'
    ];

    const allowedFields = [
      'name', 'type', 'eventDate', 'customPlan', 'eventStartTime', 'eventEndTime',
      'timeZone', 'brandColor', 'typography', 'fontStyle', 'fontSize',
      'eventPictureUrl', 'overlayId', 'overlayUrl', 'overlay', 'overlayName'
    ];

    // For PATCH requests, any restricted field present should be blocked
    const attemptedRestrictedUpdates = restrictedFields.filter(field =>
      Object.prototype.hasOwnProperty.call(updateData, field)
    );

    // Debug log for security check
    console.log('Security Check Debug (PATCH):', {
      updateDataKeys: Object.keys(updateData),
      restrictedFields,
      attemptedRestrictedUpdates,
      hasRestrictedFields: attemptedRestrictedUpdates.length > 0,
      requestType: 'PATCH - Partial Update'
    });

    if (attemptedRestrictedUpdates.length > 0) {
      console.warn('Attempted to update restricted fields via PATCH:', {
        userId: user.uid,
        eventId,
        restrictedFields: attemptedRestrictedUpdates,
        fullUpdateData: updateData
      });
      return res.status(403).json({
        error: 'Cannot update plan-related fields through this endpoint',
        details: {
          restrictedFields: attemptedRestrictedUpdates,
          allowedFields,
          message: 'Use /api/events/{eventId}/upgrade for plan changes'
        }
      });
    }

    // If event timing is being updated, validate it
    if (updateData.eventStartTime && updateData.eventEndTime) {
      const start = DateTime.fromFormat(updateData.eventStartTime, 'HH:mm');
      const end = DateTime.fromFormat(updateData.eventEndTime, 'HH:mm');
      if (!start.isValid || !end.isValid) {
        return res.status(400).json({ error: 'Invalid start or end time format (expected HH:mm)' });
      }
      let diff = end.diff(start, 'hours').hours;
      if (diff < 0) diff += 24; // handle overnight events
      if (diff > 24) {
        return res.status(400).json({ error: 'Event end time cannot be more than 24 hours after start time' });
      }
    }

    // If eventDate is being updated, validate it's not in the past
    // if (updateData.eventDate) {
    //   const newEventDate = new Date(updateData.eventDate);
    //   if (newEventDate < new Date()) {
    //     return res.status(400).json({ error: 'Event date cannot be in the past' });
    //   }
    // }

    // --- Overlay processing (like createCompleteEvent) ---
    let overlayId = null;


    let overlayUrl = null;

    // If overlay is a string, treat as admin overlay ID
    console.log('Overlay processing - updateData.overlay:', updateData.overlay, 'type:', typeof updateData.overlay);
    if (typeof updateData.overlay === 'string') {

      if (updateData.overlay.startsWith('https://')) {
        // split into path parts
        const parts = updateData.overlay.split("/").filter(Boolean);
        const last = parts[parts.length - 1]; // filename (e.g. overlayName.png)

        if (last.includes(".")) {
          // if last is filename, take the second last part as id
          overlayId = parts[parts.length - 2];
        } else {
          // if no filename, last part itself is the id
          overlayId = last;
        }

        console.log('overlayId', overlayId);
      }


      // First, check in adminOverlays
      let existingOverlayDoc = await db.collection('adminOverlays').doc(overlayId ? overlayId : updateData.overlay).get();
      if (!existingOverlayDoc.exists) {
        // If not found in adminOverlays, check in userOverlays
        existingOverlayDoc = await db.collection('userOverlays').doc(overlayId ? overlayId : updateData.overlay).get();
      }

      if (!existingOverlayDoc.exists) {
        return res.status(404).json({ error: 'Overlay not found' });
      }
      const existingOverlay = existingOverlayDoc.data();

      if (!updateData.overlay.startsWith('https://')) {
        overlayId = updateData.overlay;
        console.log('overlayId from updateData.overlay', overlayId);
      }

      overlayUrl = existingOverlay.url || null;
    }
    // If overlay file is uploaded, treat as user overlay
    else if (req.files && req.files.overlay && req.files.overlay[0]) {
      const overlayRef = db.collection('userOverlays').doc();
      overlayId = overlayRef.id;
      const overlayFile = req.files.overlay[0];
      const overlayFileName = `useroverlays/${overlayId}/overlay-${Date.now()}.png`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: overlayFileName,
        Body: overlayFile.buffer,
        ContentType: overlayFile.mimetype,
      }));
      overlayUrl = getR2PublicUrl(overlayFileName);

      // Save overlay metadata
      const overlayData = {
        ...(updateData.overlay?.name && { name: updateData.overlay.name }),
        ...(overlayUrl && { url: overlayUrl }),
        createdAt: new Date(),
        uploadedBy: user?.uid || null
      };
      await overlayRef.set(overlayData);
    }

    // Process file uploads if present
    if (req.files) {
      // Process event picture
      if (req.files.eventPicture && req.files.eventPicture[0]) {
        const eventPictureFile = req.files.eventPicture[0];
        const fileName = `events/${eventId}/banner-${Date.now()}.png`;

        console.log('fileName', fileName);
        console.log('eventPictureFile', eventPictureFile);
        console.log('req.files', req.files);

        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: fileName,
          Body: eventPictureFile.buffer,
          ContentType: eventPictureFile.mimetype,
        }));

        const eventPictureUrl = getR2PublicUrl(fileName);
        updateData.eventPictureUrl = eventPictureUrl;

        // Save event photo metadata to 'photos' collection
        const photoRef = db.collection('photos').doc();
        const photoData = {
          eventId: eventId,
          url: eventPictureUrl,
          uploadedBy: user?.uid || null,
          type: 'eventPicture',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await photoRef.set(photoData);
      }
    }

    // Add updatedAt timestamp
    updateData.updatedAt = new Date();

    // FIXED: Create final update data that preserves processed overlay and event picture data
    const finalUpdateData = { ...updateData };

    // Set overlay data in finalUpdateData (like createCompleteEvent)
    if (overlayId !== null) {
      finalUpdateData.overlayId = overlayId;
      finalUpdateData.overlayUrl = typeof overlayUrl === 'undefined' ? null : overlayUrl;
      console.log('Overlay processing completed:', { overlayId, overlayUrl, finalUpdateDataOverlayId: finalUpdateData.overlayId, finalUpdateDataOverlayUrl: finalUpdateData.overlayUrl });
    } else {
      console.log('No overlay processing needed');
    }

    // Remove any restricted fields that might have slipped through
    const safeUpdateData = { ...finalUpdateData };
    attemptedRestrictedUpdates.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(safeUpdateData, field)) {
        console.warn('Removing restricted field from update:', field);
        delete safeUpdateData[field];
      }
    });

    // Remove the 'overlay' field from the final update (we only want overlayId and overlayUrl)
    if (Object.prototype.hasOwnProperty.call(safeUpdateData, 'overlay')) {
      delete safeUpdateData.overlay;
    }

    console.log('Final Update Data:', {
      originalKeys: Object.keys(updateData),
      finalKeys: Object.keys(finalUpdateData),
      safeKeys: Object.keys(safeUpdateData),
      removedFields: Object.keys(finalUpdateData).filter(key => !Object.keys(safeUpdateData).includes(key)),
      overlayData: {
        originalOverlayId: updateData.overlayId,
        originalOverlayUrl: updateData.overlayUrl,
        finalOverlayId: finalUpdateData.overlayId,
        finalOverlayUrl: finalUpdateData.overlayUrl,
        safeOverlayId: safeUpdateData.overlayId,
        safeOverlayUrl: safeUpdateData.overlayUrl
      }
    });

    // Update the event with safe data only
    await db.collection('events').doc(eventId).update(safeUpdateData);

    // Fetch updated event
    const updatedEventDoc = await db.collection('events').doc(eventId).get();
    const updatedEvent = updatedEventDoc.data();

    // Audit log: Event update
    await auditEventUpdate(
      user.uid,
      user.email,
      eventId,
      updatedEvent.name,
      Object.keys(safeUpdateData),
      AUDIT_STATUS.SUCCESS,
      req
    );

    // Log the update
    logger.info({
      message: 'Event updated successfully',
      userId: user.uid,
      eventId,
      eventName: updatedEvent.name,
      requestedFields: Object.keys(updateData),
      actualUpdatedFields: Object.keys(safeUpdateData),
      filteredFields: Object.keys(finalUpdateData).filter(key => !Object.keys(safeUpdateData).includes(key)),
      allowedFields: Object.keys(safeUpdateData).filter(field => allowedFields.includes(field)),
      action: 'Event updated',
      status: 'success',
      security: {
        restrictedFieldsBlocked: attemptedRestrictedUpdates.length > 0 ? attemptedRestrictedUpdates : null,
        fieldsFiltered: Object.keys(finalUpdateData).filter(key => !Object.keys(safeUpdateData).includes(key)),
        userAuthenticated: true,
        ownershipVerified: true
      },
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      event: updatedEvent,
      message: 'Event updated successfully'
    });
  } catch (error) {
    logger.error({
      message: 'Event update failed',
      userId: req.user?.uid,
      eventId: req.params.id,
      error: error.message,
      stack: error.stack,
      status: 'error',
      timestamp: new Date().toISOString(),
      attemptedRestrictedUpdates: typeof attemptedRestrictedUpdates !== 'undefined' ? attemptedRestrictedUpdates : null
    });

    // Audit log: Event update
    await auditEventUpdate(
      user.uid,
      user.email,
      eventId,
      updatedEvent.name,
      Object.keys(safeUpdateData),
      AUDIT_STATUS.SUCCESS,
      req
    );
    console.error('Update Event Error:', error);
    res.status(500).json({ error: 'Failed to update event', details: error.message });
  }
};

// Upgrade event plan by ID
export const upgradeEvent = async (req, res) => {
  try {
    const eventId = req.params.id;
    const user = req.user;
    const { planId, customPlan, finalPrice, payment } = req.body;

    // Verify event exists and belongs to the user
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const existingEvent = eventDoc.data();
    if (existingEvent.userId !== user.uid) {
      return res.status(403).json({ error: 'Access denied. You can only upgrade your own events.' });
    }

    // Check if event is active
    if (existingEvent.status !== 'active') {
      return res.status(400).json({ error: 'Cannot upgrade inactive events' });
    }

    // Parse customPlan and payment if they are strings
    let parsedCustomPlan = customPlan;
    let parsedPayment = payment;

    if (typeof customPlan === 'string') {
      try {
        parsedCustomPlan = JSON.parse(customPlan);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid customPlan JSON' });
      }
    }

    if (typeof payment === 'string') {
      try {
        parsedPayment = JSON.parse(payment);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid payment JSON' });
      }
    }

    // Validate required fields
    if (!planId || !parsedCustomPlan || finalPrice === undefined) {
      return res.status(400).json({ error: 'Missing required fields: planId, customPlan, finalPrice' });
    }

    // Remove server-side plan and pricing checks
    // No fetching of plan, no price calculation, no plan constraints, no payment verification

    // Prepare upgrade data
    const upgradeData = {
      planId,
      // basePlanName and plan.name are not available without fetching plan, so omit or set to empty string
      basePlanName: '',
      customPlan: parsedCustomPlan,
      finalPrice: finalPrice, // store the client-provided price
      updatedAt: new Date()
    };

    // Update the event
    await db.collection('events').doc(eventId).update(upgradeData);

    // Fetch updated event
    const updatedEventDoc = await db.collection('events').doc(eventId).get();
    const updatedEvent = updatedEventDoc.data();

    // Audit log: Event upgrade
    await auditPaymentUpgrade(
      user.uid,
      user.email,
      eventId,
      updatedEvent.name,
      finalPrice,
      planId,
      AUDIT_STATUS.SUCCESS,
      req
    );

    // Log the upgrade
    logger.info({
      message: 'Event upgraded successfully',
      userId: user.uid,
      eventId,
      eventName: updatedEvent.name,
      oldPlanId: existingEvent.planId,
      newPlanId: planId,
      finalPrice: finalPrice,
      paymentIntentId: parsedPayment?.paymentIntentId || null,
      action: 'Event upgraded',
      status: 'success',
      security: {
        // No server-side validation
        priceValidated: false,
        planValidated: false,
        paymentVerified: false,
        userAuthenticated: true
      },
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      event: updatedEvent,
      payment: {
        id: parsedPayment?.paymentIntentId || null,
        status: parsedPayment?.status || null,
        amount: parsedPayment?.amount || null
      },
      message: 'Event upgraded successfully'
    });
  } catch (error) {

    logger.error({
      message: 'Event upgrade failed',
      userId: req.user?.uid,
      eventId: req.params.id,
      error: error.message,
      stack: error.stack,
      status: 'error',
      timestamp: new Date().toISOString()
    });


    // Audit log: Event upgrade
    await auditPaymentUpgrade(
      user.uid,
      user.email,
      eventId,
      updatedEvent.name,
      finalPrice,
      planId,
      AUDIT_STATUS.SUCCESS,
      req
    );
    console.error('Upgrade Event Error:', error);
    res.status(500).json({ error: 'Failed to upgrade event', details: error.message });
  }
};

// Get all photos for all guests for an event, sorted by latest photo upload
// Now also returns the event shareCode in the response
export const getEventPhotos = async (req, res) => {
  try {
    const eventId = req.params.id;
    const currentUserId = req.user?.uid; // Get current user ID if authenticated

    // Fetch event to get shareCode
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const eventData = eventDoc.data();
    const shareCode = eventData.shareCode || null;

    // Get all guests for the event
    const guestsSnap = await db.collection('guests').where('eventId', '==', eventId).get();
    const guestIds = guestsSnap.docs.map(doc => doc.data().guestId || doc.id);

    if (guestIds.length === 0) {
      return res.json({ photos: [], shareCode }); // No guests, return empty array and shareCode
    }

    // Check storage days expiration
    const storageCheck = checkStorageExpiration(eventData);
    console.log('storageCheck', storageCheck);
    if (storageCheck.expired) {
      return res.status(403).json({ error: storageCheck.message });
    }

    // If only one guest, fetch all their photos (not just the latest)
    if (guestIds.length === 1) {
      const guestId = guestIds[0];
      const photosSnap = await db
        .collection('photos')
        .where('eventId', '==', eventId)
        .where('guestId', '==', guestId)
        .orderBy('createdAt', 'desc')
        .get();

      let latestPhoto = photosSnap.docs.map(doc => {
        const photoData = doc.data();
        if (currentUserId) {
          const likes = photoData.likes || [];
          return {
            ...photoData,
            isLiked: likes.includes(currentUserId)
          };
        }
        return photoData;
      });

      return res.json({ latestPhoto, shareCode, EventType: eventData.type, eventName: eventData.name, eventId: eventId });
    }

    // Otherwise, get all photos for the event, ordered by createdAt descending (latest first)
    const photosSnap = await db
      .collection('photos')
      .where('eventId', '==', eventId)
      .orderBy('createdAt', 'desc')
      .get();

    // Collect all photos, add isLiked if user is authenticated
    const allPhotos = photosSnap.docs.map(doc => {
      const photo = doc.data();
      if (!photo.guestId) return null; // skip if no guestId
      if (currentUserId) {
        const likes = photo.likes || [];
        return {
          ...photo,
          isLiked: likes.includes(currentUserId)
        };
      }
      return photo;
    }).filter(Boolean);

    res.json({ photos: allPhotos, shareCode, eventName: eventData.name, eventId: eventId, EventType: eventData.type });
  } catch (error) {
    console.error('Get Event Photos Error:', error);

    // Audit log: Get event photos failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.id,
      eventName: null,
      action: 'Get event photos failed',
      details: {
        eventId: req.params.id,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch event photos' });
  }
};

// Get all photos by guest for an event, sorted by latest uploaded photo
export const getAllPhotosByGuest = async (req, res) => {
  try {
    const eventId = req.params.id;
    const guestId = req.params.guestId;
    const currentUserId = req.user?.uid; // Get current user ID if authenticated

    if (!guestId) {
      return res.status(400).json({ error: 'Missing guestId parameter' });
    }
    // Get all photos for the event and guest, ordered by createdAt descending
    const photosSnap = await db
      .collection('photos')
      .where('eventId', '==', eventId)
      .where('guestId', '==', guestId)
      .orderBy('createdAt', 'desc')
      .get();

    const photos = photosSnap.docs.map(doc => {
      const photoData = doc.data();
      // Add like information if user is authenticated
      if (currentUserId) {
        const likes = photoData.likes || [];
        return {
          ...photoData,
          isLiked: likes.includes(currentUserId)
        };
      }
      return photoData;
    });

    res.json(photos);
  } catch (error) {
    console.error('Get All Photos By Guest Error:', error);

    // Audit log: Get all photos by guest failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.id,
      eventName: null,
      action: 'Get all photos by guest failed',
      details: {
        eventId: req.params.id,
        guestId: req.params.guestId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch guest photos', details: error.message });
  }
};

// Get all guests for an event
export const getEventGuests = async (req, res) => {
  try {
    const eventId = req.params.id;
    const guestsSnap = await db.collection('guests').where('eventId', '==', eventId).get();
    const guests = guestsSnap.docs.map(doc => doc.data());
    res.json(guests);
  } catch (error) {
    console.error('Get Event Guests Error:', error);

    // Audit log: Get event guests failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.id,
      eventName: null,
      action: 'Get event guests failed',
      details: {
        eventId: req.params.id,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch event guests' });
  }
};



// POST endpoint to update guest consent
// export const updateGuestConsent = async (req, res) => {
//   try {
//     const shareCode = req.params.shareCode;
//     const guestId = req.body.guestId;
//     if (!guestId) return res.status(400).json({ error: 'Missing guestId' });
//     const eventsSnap = await db.collection('events').where('shareCode', '==', shareCode).limit(1).get();
//     if (eventsSnap.empty) return res.status(404).json({ error: 'Event not found' });
//     const event = eventsSnap.docs[0].data();
//     // Find guest doc
//     const guestSnap = await db.collection('guests')
//       .where('eventId', '==', event.eventId)
//       .where('guestId', '==', guestId)
//       .limit(1).get();
//     if (guestSnap.empty) {
//       // Create guest doc if not exists
//       await db.collection('guests').add({
//         eventId: event.eventId,
//         guestId,
//         termsAccepted: true,
//         photosUploaded: 0,
//         createdAt: new Date()
//       });
//     } else {
//       // Update consent
//       await db.collection('guests').doc(guestSnap.docs[0].id).update({ termsAccepted: true });
//     }
//     res.json({ success: true });
//   } catch (error) {
//     console.error('Update Guest Consent Error:', error);
//     res.status(500).json({ error: 'Failed to update guest consent' });
//   }
// };

// // Get photos uploaded by a guest for an event
// export const getGuestPhotos = async (req, res) => {
//   try {
//     const { eventId, guestId } = req.params;
//     // Check guest consent
//     const guestSnap = await db.collection('guests')
//       .where('eventId', '==', eventId)
//       .where('guestId', '==', guestId)
//       .limit(1).get();
//     if (guestSnap.empty) return res.status(403).json({ error: 'Guest not found' });
//     const guest = guestSnap.docs[0].data();
//     if (!guest.termsAccepted) return res.status(403).json({ error: 'Consent not accepted' });
//     // Get photos
//     const photosSnap = await db.collection('photos')
//       .where('eventId', '==', eventId)
//       .where('guestId', '==', guestId)
//       .get();
//     const photos = photosSnap.docs.map(doc => doc.data());
//     res.json(photos);
//   } catch (error) {
//     console.error('Get Guest Photos Error:', error);
//     res.status(500).json({ error: 'Failed to fetch guest photos' });
//   }
// };

// // Upload a photo as a guest (enforce photo limit)
// export const uploadGuestPhoto = async (req, res) => {
//   try {
//     const { eventId, guestId } = req.params;
//     const { file } = req.body;
//     if (!file) return res.status(400).json({ error: 'Missing file' });
//     // Check guest consent
//     const guestSnap = await db.collection('guests')
//       .where('eventId', '==', eventId)
//       .where('guestId', '==', guestId)
//       .limit(1).get();
//     if (guestSnap.empty) return res.status(403).json({ error: 'Guest not found' });
//     const guest = guestSnap.docs[0].data();
//     if (!guest.termsAccepted) return res.status(403).json({ error: 'Consent not accepted' });
//     // Get event and plan
//     const eventDoc = await db.collection('events').doc(eventId).get();
//     if (!eventDoc.exists) return res.status(404).json({ error: 'Event not found' });
//     const event = eventDoc.data();
//     const maxPhotos = event.plan?.photosPerGuest || 0;
//     const uploaded = guest.photosUploaded || 0;
//     if (uploaded >= maxPhotos) return res.status(403).json({ error: 'Photo upload limit reached' });
//     // Upload photo
//     const photoId = db.collection('photos').doc().id;
//     const fileName = `photos/${eventId}/${guestId}/${photoId}-${Date.now()}.png`;
//     const photoUrl = await uploadBase64File(file, fileName);
//     await db.collection('photos').doc(photoId).set({
//       photoId,
//       eventId,
//       guestId,
//       url: photoUrl,
//       createdAt: new Date()
//     });
//     // Update guest's photosUploaded
//     await db.collection('guests').doc(guestSnap.docs[0].id).update({
//       photosUploaded: uploaded + 1
//     });
//     res.json({ success: true, photoId, url: photoUrl });
//   } catch (error) {
//     console.error('Upload Guest Photo Error:', error);
//     res.status(500).json({ error: 'Failed to upload photo' });
//   }
// };



// Get user profile
export const getUserProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    res.json(userSnap.data());
  } catch (error) {
    console.error('Get User Profile Error:', error);

    // Audit log: Get user profile failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: null,
      eventName: null,
      action: 'Get user profile failed',
      details: {
        requestedUserId: req.params.userId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
};

// Update user profile
export const updateUserProfile = async (req, res) => {
  try {
    const { userId } = req.params;

    // req.body may be undefined if using multipart/form-data and no body parser for it
    // So, always check for req.body existence and fallback to empty object
    const body = req.body || {};

    // Only update provided fields
    const updateData = {};
    if (typeof body.fullName !== "undefined") updateData.fullName = body.fullName;
    if (typeof body.email !== "undefined") updateData.email = body.email;
    if (typeof body.phoneNumber !== "undefined") updateData.phoneNumber = body.phoneNumber;
    if (typeof body.location !== "undefined") updateData.location = body.location;
    if (typeof body.timeZone !== "undefined") updateData.timeZone = body.timeZone;

    // Handle profile photo upload to R2 if present (multer file in form-data)
    let profilePictureUrl = null;

    // Debug logging
    // console.log('Files received:', req.files);
    // console.log('Profile picture file:', req.files?.profilePicture);

    if (req.files && req.files.profilePicture && req.files.profilePicture[0]) {
      // Multer file upload (buffer)
      const profilePicFile = req.files.profilePicture[0];
      const fileName = `profile_pics/${userId}-${Date.now()}.png`;

      // console.log('Uploading file to R2:', {
      //   fileName,
      //   fileSize: profilePicFile.size,
      //   mimeType: profilePicFile.mimetype,
      //   bucket: process.env.R2_BUCKET
      // });

      try {
        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: fileName,
          Body: profilePicFile.buffer,
          ContentType: profilePicFile.mimetype,
        }));
        console.log('File uploaded successfully to R2');

        profilePictureUrl = getR2PublicUrl(fileName);
        updateData.profilePictureUrl = profilePictureUrl;
        console.log('Profile picture uploaded:', profilePictureUrl);
      } catch (uploadError) {
        console.error('R2 upload error:', uploadError);
        throw new Error(`Failed to upload profile picture: ${uploadError.message}`);
      }
    } else if (body.profilePicture) {
      // Base64 string upload (should not happen with form-data, but keep for fallback)
      const base64Data = body.profilePicture.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `profile_pics/${userId}-${Date.now()}.png`;

      console.log('Uploading base64 file to R2:', {
        fileName,
        bufferSize: buffer.length,
        bucket: process.env.R2_BUCKET
      });

      try {
        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: fileName,
          Body: buffer,
          ContentType: 'image/png',
        }));
        console.log('Base64 file uploaded successfully to R2');

        profilePictureUrl = getR2PublicUrl(fileName);
        updateData.profilePictureUrl = profilePictureUrl;
        console.log('Profile picture uploaded (base64):', profilePictureUrl);
      } catch (uploadError) {
        console.error('R2 base64 upload error:', uploadError);
        throw new Error(`Failed to upload base64 profile picture: ${uploadError.message}`);
      }
    } else {
      console.log('No profile picture uploaded');
    }

    // console.log('Update data:', updateData);
    // console.log('Profile picture URL:', profilePictureUrl);
    // Save updated data (including profilePictureUrl if present)
    await db.collection('users').doc(userId).set(updateData, { merge: true });
    const updatedUser = (await db.collection('users').doc(userId).get()).data();
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error('Update User Profile Error:', error);
    res.status(500).json({ error: 'Failed to update user profile', details: error.message });
  }
};

// Helper functions
const generateShareCode = () => {
  return Math.random().toString(36).substring(2, 7)
  //  Math.random().toString(36).substring(2, 8);
};

// const uploadBase64File = async (base64Data, fileName) => {
//   const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
//   const buffer = Buffer.from(base64, 'base64');

//   const file = bucket.file(fileName);
//   await file.save(buffer, {
//     metadata: { contentType: 'image/png' },
//     public: true
//   });

//   return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
// };

// Helper to construct R2 public URL without R2_PUBLIC_DOMAIN
function getR2PublicUrl(key) {
  // console.log('R2_PUBLIC_DOMAIN:', process.env.R2_PUBLIC_DOMAIN);
  // console.log('R2_BUCKET:', process.env.R2_BUCKET);
  // console.log('Key:', key);

  const endpoint = `${process.env.R2_PUBLIC_DOMAIN}/${process.env.R2_BUCKET}/${key}`;
  // console.log('Generated URL:', endpoint);
  return endpoint;
}