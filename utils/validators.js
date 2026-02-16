import Joi from 'joi';

export const validateEventData = (data) => {
  const schema = Joi.object({
    name: Joi.string().required().min(3).max(100),
    type: Joi.string().required().valid('wedding', 'birthday', 'corporate', 'other'),
    date: Joi.date().required().min('now'),
    timeZone: Joi.string().required(),
    brandColor: Joi.string().pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/),
    typography: Joi.string().default('Inter'),
    overlayId: Joi.string().allow(null),
    planId: Joi.string().required(),
    guestPermissions: Joi.object({
      canViewGallery: Joi.boolean().default(true),
      canSharePhotos: Joi.boolean().default(true),
      canDownload: Joi.boolean().default(false)
    }).default()
  });
  
  return schema.validate(data);
};

export const validateOverlayData = (data) => {
  const schema = Joi.object({
    file: Joi.string().base64().required(),
    category: Joi.string().required().valid('birthday', 'wedding', 'anniversary', 'corporate'),
    orientation: Joi.string().required().valid('portrait', 'landscape')
  });
  
  return schema.validate(data);
};

  /**
 * Prepare PATCH request data by comparing with original data
 * Only includes fields that have actually changed
 * @param {Object} newData - The new form data
 * @param {Object} originalData - The original event data
 * @returns {Object} - Object containing only changed fields
 */
export const preparePatchData = (newData, originalData) => {
  const patchData = {};
  
  Object.keys(newData).forEach(key => {
    const newValue = newData[key];
    const originalValue = originalData[key];
    
    // Skip if value is undefined or null in new data
    if (newValue === undefined || newValue === null) {
      return;
    }
    
    // Handle different data types for comparison
    let hasChanged = false;
    
    if (typeof newValue === 'object' && typeof originalValue === 'object') {
      // For objects (like customPlan), compare JSON strings
      hasChanged = JSON.stringify(newValue) !== JSON.stringify(originalValue);
    } else if (typeof newValue === 'string' && typeof originalValue === 'number') {
      // Handle string vs number comparison (e.g., "16" vs 16)
      hasChanged = parseFloat(newValue) !== originalValue;
    } else if (typeof newValue === 'number' && typeof originalValue === 'string') {
      // Handle number vs string comparison
      hasChanged = newValue !== parseFloat(originalValue);
    } else {
      // Direct comparison for same types
      hasChanged = newValue !== originalValue;
    }
    
    if (hasChanged) {
      patchData[key] = newValue;
    }
  });
  
  return patchData;
};

/**
 * Validate PATCH data to ensure no restricted fields are included
 * @param {Object} patchData - The PATCH request data
 * @returns {Object} - Validation result with success and errors
 */
export const validatePatchData = (patchData) => {
  const restrictedFields = [
    'planId', 'customPlan', 'finalPrice', 'basePlanName', 
    'payment', 'qrCodeUrl', 'shareCode', 'status', 'userId',
    'createdAt', 'stripeCustomerId', 'stripePaymentIntentId'
  ];
  
  const foundRestrictedFields = restrictedFields.filter(field => 
    Object.prototype.hasOwnProperty.call(patchData, field)
  );
  
  if (foundRestrictedFields.length > 0) {
    return {
      isValid: false,
      errors: [`Cannot update restricted fields: ${foundRestrictedFields.join(', ')}`],
      restrictedFields: foundRestrictedFields
    };
  }
  
  return {
    isValid: true,
    errors: []
  };
};

/**
 * FRONTEND USAGE EXAMPLE:
 * 
 * // 1. Import the utility functions
 * import { preparePatchData, validatePatchData } from './utils/validators.js';
 * 
 * // 2. When updating an event, prepare the PATCH data
 * const updateEvent = async (eventId, newFormData, originalEventData) => {
 *   try {
 *     // Prepare PATCH data (only changed fields)
 *     const patchData = preparePatchData(newFormData, originalEventData);
 *     
 *     // Validate the PATCH data
 *     const validation = validatePatchData(patchData);
 *     if (!validation.isValid) {
 *       console.error('Validation failed:', validation.errors);
 *       return { success: false, errors: validation.errors };
 *     }
 *     
 *     // Check if there are any changes to send
 *     if (Object.keys(patchData).length === 0) {
 *       return { success: true, message: 'No changes detected' };
 *     }
 *     
 *     // Send PATCH request
 *     const response = await fetch(`/api/events/${eventId}`, {
 *       method: 'PATCH',
 *       headers: {
 *         'Content-Type': 'application/json',
 *         'Authorization': `Bearer ${userToken}`
 *       },
 *       body: JSON.stringify(patchData)
 *     });
 *     
 *     const result = await response.json();
 *     return result;
 *   } catch (error) {
 *     console.error('Update failed:', error);
 *     return { success: false, error: error.message };
 *   }
 * };
 * 
 * // 3. Example usage in a React component
 * const handleSubmit = async (formData) => {
 *   const result = await updateEvent(eventId, formData, originalEvent);
 *   if (result.success) {
 *     // Handle success
 *   } else {
 *     // Handle error
 *   }
 * };
 */

// Add more validators as needed