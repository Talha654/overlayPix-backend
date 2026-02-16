import { db } from "../../services/firebase.service.js";
import { successResponse, serverErrorResponse, badRequestResponse, notFoundResponse } from "../../utils/responses.js";
// import { createAuditLog } from "../../services/audit.service.js";
import { 
  validateDiscountCode as validateDiscountCodeService,
  applyDiscountCode as applyDiscountCodeService,
  generateUniqueCode,
  getDiscountCodeUsage,
  getDiscountCodeStatistics
} from "../../services/discountcode.service.js";

// CREATE - Create a new discount code
export const createDiscountCode = async (req, res) => {
  try {
    const {
      code,
      discountType, // 'percentage' or 'fixed'
      discountValue, // percentage (0-100) or fixed amount
      startDate,
      startTime,
      expireDate,
      expireTime
    } = req.body;

    // Validation
    if (!code || !discountType || !discountValue || !startDate || !expireDate) {
      return badRequestResponse(res, "Missing required fields: code, discountType, discountValue, startDate, expireDate");
    }

    // Validate discount type
    if (!['percentage', 'fixed'].includes(discountType)) {
      return badRequestResponse(res, "Discount type must be 'percentage' or 'fixed'");
    }

    // Validate discount value
    if (discountType === 'percentage' && (discountValue < 0 || discountValue > 100)) {
      return badRequestResponse(res, "Percentage discount must be between 0 and 100");
    }

    if (discountType === 'fixed' && discountValue < 0) {
      return badRequestResponse(res, "Fixed discount amount cannot be negative");
    }

    // Check if code already exists
    const existingCode = await db.collection('discountCodes').where('code', '==', code.toUpperCase()).get();
    if (!existingCode.empty) {
      return badRequestResponse(res, "Discount code already exists");
    }

    // Parse dates and times
    const startDateTime = new Date(`${startDate}T${startTime || '00:00'}`);
    const expireDateTime = new Date(`${expireDate}T${expireTime || '23:59'}`);
    
    console.log('Creating discount code with dates:', {
      startDate,
      startTime,
      startDateTime: startDateTime.toISOString(),
      startDateTimeLocal: startDateTime.toString(),
      expireDate,
      expireTime,
      expireDateTime: expireDateTime.toISOString(),
      expireDateTimeLocal: expireDateTime.toString()
    });

    // Validate dates
    if (startDateTime >= expireDateTime) {
      return badRequestResponse(res, "Expire date must be after start date");
    }

    // if (startDateTime < new Date()) {
    //   return badRequestResponse(res, "Start date cannot be in the past");
    // }

    // Create discount code document
    const discountCodeData = {
      code: code.toUpperCase(),
      discountType,
      discountValue: parseFloat(discountValue),
      startDate: startDateTime,
      expireDate: expireDateTime,
      isActive: true,
      currentUses: 0,
      createdAt: new Date(),
      createdBy: req.user?.uid || 'admin',
      
    };

    const docRef = await db.collection('discountCodes').add(discountCodeData);

    // Create audit log
    // await createAuditLog({
    //   type: 'discount_code_created',
    //   action: 'Created discount code',
    //   userId: req.user?.uid || 'admin',
    //   details: {
    //     code: code.toUpperCase(),
    //     discountType,
    //     discountValue: parseFloat(discountValue),
    //     discountCodeId: docRef.id
    //   }
    // });

    return successResponse(res, "Discount code created successfully", {
      id: docRef.id,
      ...discountCodeData
    });

  } catch (error) {
    console.error("Error creating discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// READ - Get all discount codes with pagination
export const getAllDiscountCodes = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status = 'all', // 'all', 'active', 'expired', 'inactive'
      search = ''
    } = req.query;

    let query = db.collection('discountCodes');

    // Apply status filter
    if (status === 'active') {
      query = query.where('isActive', '==', true);
    } else if (status === 'expired') {
      query = query.where('expireDate', '<', new Date());
    } else if (status === 'inactive') {
      query = query.where('isActive', '==', false);
    }

    // Apply search filter
    if (search) {
      query = query.where('code', '>=', search.toUpperCase())
                   .where('code', '<=', search.toUpperCase() + '\uf8ff');
    }

    // Get total count for pagination
    const totalSnapshot = await query.get();
    const totalCodes = totalSnapshot.size;

    // Apply pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const snapshot = await query
      .orderBy('createdAt', 'desc')
      .offset(offset)
      .limit(parseInt(limit))
      .get();

    const discountCodes = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        startDate: data.startDate.toDate().toISOString(),
        expireDate: data.expireDate.toDate().toISOString(),
        createdAt: data.createdAt.toDate().toISOString(),
        isExpired: data.expireDate.toDate() < new Date()
      };
    });

    return successResponse(res, "Discount codes retrieved successfully", {
      discountCodes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCodes,
        totalPages: Math.ceil(totalCodes / parseInt(limit)),
        hasMore: offset + discountCodes.length < totalCodes
      }
    });

  } catch (error) {
    console.error("Error fetching discount codes:", error);
    return serverErrorResponse(res, error.message);
  }
};

// READ - Get single discount code
export const getDiscountCode = async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await db.collection('discountCodes').doc(id).get();

    if (!doc.exists) {
      return notFoundResponse(res, "Discount code not found");
    }

    const data = doc.data();
    const discountCode = {
      id: doc.id,
      ...data,
      startDate: data.startDate.toDate().toISOString(),
      expireDate: data.expireDate.toDate().toISOString(),
      createdAt: data.createdAt.toDate().toISOString(),
      isExpired: data.expireDate.toDate() < new Date()
    };

    return successResponse(res, "Discount code retrieved successfully", discountCode);

  } catch (error) {
    console.error("Error fetching discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// UPDATE - Update discount code
export const updateDiscountCode = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      code,
      discountType,
      discountValue,
      startDate,
      startTime,
      expireDate,
      expireTime,
      isActive
    } = req.body;

    // Check if discount code exists
    const doc = await db.collection('discountCodes').doc(id).get();
    if (!doc.exists) {
      return notFoundResponse(res, "Discount code not found");
    }

    const updateData = {};

    // Update fields if provided
    if (code !== undefined) {
      // Check if new code already exists (excluding current code)
      const existingCode = await db.collection('discountCodes')
        .where('code', '==', code.toUpperCase())
        .get();
      
      const existingDoc = existingCode.docs.find(doc => doc.id !== id);
      if (existingDoc) {
        return badRequestResponse(res, "Discount code already exists");
      }
      updateData.code = code.toUpperCase();
    }

    if (discountType !== undefined) {
      if (!['percentage', 'fixed'].includes(discountType)) {
        return badRequestResponse(res, "Discount type must be 'percentage' or 'fixed'");
      }
      updateData.discountType = discountType;
    }

    if (discountValue !== undefined) {
      if (discountType === 'percentage' && (discountValue < 0 || discountValue > 100)) {
        return badRequestResponse(res, "Percentage discount must be between 0 and 100");
      }
      if (discountType === 'fixed' && discountValue < 0) {
        return badRequestResponse(res, "Fixed discount amount cannot be negative");
      }
      updateData.discountValue = parseFloat(discountValue);
    }

    if (startDate && expireDate) {
      const startDateTime = new Date(`${startDate}T${startTime || '00:00'}`);
      const expireDateTime = new Date(`${expireDate}T${expireTime || '23:59'}`);

      if (startDateTime >= expireDateTime) {
        return badRequestResponse(res, "Expire date must be after start date");
      }

      updateData.startDate = startDateTime;
      updateData.expireDate = expireDateTime;
    }



    if (isActive !== undefined) {
      updateData.isActive = Boolean(isActive);
    }

    updateData.updatedAt = new Date();
    updateData.updatedBy = req.user?.uid || 'admin';

    await db.collection('discountCodes').doc(id).update(updateData);

    // Create audit log
    // await createAuditLog({
    //   type: 'discount_code_updated',
    //   action: 'Updated discount code',
    //   userId: req.user?.uid || 'admin',
    //   details: {
    //     discountCodeId: id,
    //     updatedFields: Object.keys(updateData)
    //   }
    // });

    return successResponse(res, "Discount code updated successfully", { updatedData: updateData });

  } catch (error) {
    console.error("Error updating discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// DELETE - Delete discount code
export const deleteDiscountCode = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if discount code exists
    const doc = await db.collection('discountCodes').doc(id).get();
    if (!doc.exists) {
      return notFoundResponse(res, "Discount code not found");
    }

    // Check if code has been used
    const data = doc.data();
    if (data.currentUses > 0) {
      return badRequestResponse(res, "Cannot delete discount code that has been used");
    }

    await db.collection('discountCodes').doc(id).delete();

    // Create audit log
    // await createAuditLog({
    //   type: 'discount_code_deleted',
    //   action: 'Deleted discount code',
    //   userId: req.user?.uid || 'admin',
    //   details: {
    //     discountCodeId: id,
    //     code: data.code
    //   }
    // });

    return successResponse(res, "Discount code deleted successfully");

  } catch (error) {
    console.error("Error deleting discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// VALIDATE - Validate discount code for use
export const validateDiscountCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return badRequestResponse(res, "Discount code is required");
    }

    const validation = await validateDiscountCodeService(code);

    if (!validation.isValid) {
      return badRequestResponse(res, validation.error);
    }

    return successResponse(res, "Discount code is valid", validation);

  } catch (error) {
    console.error("Error validating discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// APPLY - Apply discount code and track usage
export const applyDiscountCode = async (req, res) => {
  try {
    const { code, orderAmount, eventId } = req.body;

    if (!code || !orderAmount || !eventId) {
      return badRequestResponse(res, "Code, orderAmount, and eventId are required");
    }

    const result = await applyDiscountCodeService(code, orderAmount, eventId, req.user?.uid);

    if (!result.success) {
      return badRequestResponse(res, result.error);
    }

    return successResponse(res, "Discount code applied successfully", result);

  } catch (error) {
    console.error("Error applying discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// STATS - Get discount code statistics
export const getDiscountCodeStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const stats = await getDiscountCodeStatistics({ startDate, endDate });

    return successResponse(res, "Discount code statistics retrieved successfully", stats);

  } catch (error) {
    console.error("Error fetching discount code statistics:", error);
    return serverErrorResponse(res, error.message);
  }
};

// GENERATE - Generate unique discount code
export const generateDiscountCode = async (req, res) => {
  try {
    const { length = 8 } = req.query;
    
    const code = await generateUniqueCode(parseInt(length));
    
    return successResponse(res, "Unique discount code generated successfully", { code });
    
  } catch (error) {
    console.error("Error generating discount code:", error);
    return serverErrorResponse(res, error.message);
  }
};

// USAGE - Get discount code usage history
export const getDiscountCodeUsageHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    // Check if discount code exists
    const doc = await db.collection('discountCodes').doc(id).get();
    if (!doc.exists) {
      return notFoundResponse(res, "Discount code not found");
    }

    const usage = await getDiscountCodeUsage(id, { page, limit });

    return successResponse(res, "Discount code usage history retrieved successfully", usage);

  } catch (error) {
    console.error("Error fetching discount code usage history:", error);
    return serverErrorResponse(res, error.message);
  }
};
