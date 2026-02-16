import { db } from "./firebase.service.js";
import { createAuditLog } from "./audit.service.js";

// Calculate discount amount based on type and value
export const calculateDiscountAmount = (discountType, discountValue, orderAmount) => {
  let discountAmount = 0;
  
  if (discountType === 'percentage') {
    discountAmount = (orderAmount * discountValue) / 100;
  } else if (discountType === 'fixed') {
    discountAmount = discountValue;
  }
  
  // Ensure discount doesn't exceed order amount
  return Math.min(discountAmount, orderAmount);
};

// Validate discount code
export const validateDiscountCode = async (code) => {
  try {
    // Find the discount code
    const snapshot = await db.collection('discountCodes')
      .where('code', '==', code.toUpperCase())
      .get();

    if (snapshot.empty) {
      return { isValid: false, error: "Invalid discount code" };
    }

    const doc = snapshot.docs[0];
    const discountCode = doc.data();

    // Check if code is active
    if (!discountCode.isActive) {
      return { isValid: false, error: "Discount code is inactive" };
    }

    // Check if code has started
    const now = new Date();
    const startDate = discountCode.startDate.toDate();
    const expireDate = discountCode.expireDate.toDate();
    
    console.log('Discount code validation debug:', {
      code: discountCode.code,
      now: now.toISOString(),
      nowLocal: now.toString(),
      startDate: startDate.toISOString(),
      startDateLocal: startDate.toString(),
      expireDate: expireDate.toISOString(),
      expireDateLocal: expireDate.toString(),
      isStarted: startDate <= now,
      isExpired: expireDate < now,
      timeDifference: startDate.getTime() - now.getTime(),
      timeDifferenceHours: (startDate.getTime() - now.getTime()) / (1000 * 60 * 60)
    });
    
    if (startDate > now) {
      return { isValid: false, error: "Discount code has not started yet" };
    }

    // Check if code has expired
    if (expireDate < now) {
      return { isValid: false, error: "Discount code has expired" };
    }

    return {
      isValid: true,
      discountCode: {
        id: doc.id,
        code: discountCode.code,
        discountType: discountCode.discountType,
        discountValue: discountCode.discountValue
      }
    };

  } catch (error) {
    console.error("Error validating discount code:", error);
    return { isValid: false, error: "Error validating discount code" };
  }
};

// Apply discount code and track usage
export const applyDiscountCode = async (code, orderAmount, eventId, userId = 'anonymous') => {
  try {
    // Validate the discount code first
    const validation = await validateDiscountCode(code);
    
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const discountCodeId = validation.discountCode.id;
    const discountAmount = calculateDiscountAmount(
      validation.discountCode.discountType, 
      validation.discountCode.discountValue, 
      orderAmount
    );

    // Use transaction to ensure atomicity
    const result = await db.runTransaction(async (transaction) => {
      // Get the discount code document
      const docRef = db.collection('discountCodes').doc(discountCodeId);
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        throw new Error("Discount code not found");
      }

      const discountCode = doc.data();

      // Update usage count and total discount given
      transaction.update(docRef, {
        currentUses: discountCode.currentUses + 1,
        totalDiscountGiven: discountCode.totalDiscountGiven + discountAmount,
        lastUsedAt: new Date()
      });

      // Create usage record
      const usageRef = db.collection('discountCodeUsage').doc();
      transaction.set(usageRef, {
        discountCodeId,
        code: discountCode.code,
        eventId,
        orderAmount: parseFloat(orderAmount),
        discountAmount: parseFloat(discountAmount),
        usedAt: new Date(),
        usedBy: userId
      });

      return {
        discountAmount: parseFloat(discountAmount),
        finalAmount: parseFloat((orderAmount - discountAmount).toFixed(2))
      };
    });

    // Create audit log
    await createAuditLog({
      type: 'discount_code_applied',
      action: 'Applied discount code',
      userId: userId,
      details: {
        discountCodeId,
        code: code.toUpperCase(),
        eventId,
        orderAmount: parseFloat(orderAmount),
        discountAmount: result.discountAmount
      }
    });

    return { success: true, ...result };

  } catch (error) {
    console.error("Error applying discount code:", error);
    return { success: false, error: error.message };
  }
};

// Generate unique discount code
export const generateUniqueCode = async (length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Check if code already exists
    const existingCode = await db.collection('discountCodes')
      .where('code', '==', code)
      .get();

    if (existingCode.empty) {
      return code;
    }

    attempts++;
  }

  throw new Error("Unable to generate unique discount code");
};

// Get discount code usage history
export const getDiscountCodeUsage = async (discountCodeId, options = {}) => {
  try {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    let query = db.collection('discountCodeUsage')
      .where('discountCodeId', '==', discountCodeId)
      .orderBy('usedAt', 'desc');

    // Get total count
    const totalSnapshot = await query.get();
    const totalUsage = totalSnapshot.size;

    // Apply pagination
    const snapshot = await query
      .offset(offset)
      .limit(limit)
      .get();

    const usage = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        usedAt: data.usedAt.toDate().toISOString()
      };
    });

    return {
      usage,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalUsage,
        totalPages: Math.ceil(totalUsage / parseInt(limit)),
        hasMore: offset + usage.length < totalUsage
      }
    };

  } catch (error) {
    console.error("Error fetching discount code usage:", error);
    throw error;
  }
};

// Get discount code statistics
export const getDiscountCodeStatistics = async (filters = {}) => {
  try {
    const { startDate, endDate } = filters;

    let query = db.collection('discountCodes');
    
    if (startDate && endDate) {
      query = query.where('createdAt', '>=', new Date(startDate))
                   .where('createdAt', '<=', new Date(endDate));
    }

    const snapshot = await query.get();

    const stats = {
      totalCodes: snapshot.size,
      activeCodes: 0,
      expiredCodes: 0,
      totalUses: 0,
      totalDiscountGiven: 0,
      averageDiscount: 0,
      codesByType: {
        percentage: 0,
        fixed: 0
      },
      recentUsage: 0, // Last 7 days
      topUsedCodes: []
    };

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      
      if (data.isActive) stats.activeCodes++;
      if (data.expireDate.toDate() < now) stats.expiredCodes++;
      
      stats.totalUses += data.currentUses || 0;
      stats.totalDiscountGiven += data.totalDiscountGiven || 0;
      
      if (data.discountType === 'percentage') {
        stats.codesByType.percentage++;
      } else {
        stats.codesByType.fixed++;
      }

      // Check recent usage
      if (data.lastUsedAt && data.lastUsedAt.toDate() >= sevenDaysAgo) {
        stats.recentUsage++;
      }

      // Track top used codes
      if (data.currentUses > 0) {
        stats.topUsedCodes.push({
          code: data.code,
          uses: data.currentUses,
          totalDiscount: data.totalDiscountGiven || 0
        });
      }
    });

    // Sort top used codes by usage count
    stats.topUsedCodes.sort((a, b) => b.uses - a.uses);
    stats.topUsedCodes = stats.topUsedCodes.slice(0, 5); // Top 5

    stats.averageDiscount = stats.totalUses > 0 ? 
      parseFloat((stats.totalDiscountGiven / stats.totalUses).toFixed(2)) : 0;

    return stats;

  } catch (error) {
    console.error("Error fetching discount code statistics:", error);
    throw error;
  }
};

// Test function to verify date handling
export const testDateHandling = () => {
  const testStartDate = new Date('2025-08-15T12:00:00.000Z');
  const testExpireDate = new Date('2025-08-31T23:59:59.000Z');
  const now = new Date();
  
  console.log('Date handling test:', {
    now: now.toISOString(),
    testStartDate: testStartDate.toISOString(),
    testExpireDate: testExpireDate.toISOString(),
    isStarted: testStartDate <= now,
    isExpired: testExpireDate < now
  });
  
  return {
    isStarted: testStartDate <= now,
    isExpired: testExpireDate < now
  };
};
