import { db } from "./firebase.service.js";

// Audit log types
export const AUDIT_TYPES = {
  PHOTO_UPLOAD: 'photo_upload',
  PHOTO_DELETE: 'photo_delete',
  LOGIN: 'login',
  SIGNUP: 'signup',
  EVENT_CREATE: 'event_create',
  EVENT_UPDATE: 'event_update',
  EVENT_DELETE: 'event_delete',
  EVENT_TOGGLE: 'event_toggle',
  EVENT_EXPIRE: 'event_expire',
  PAYMENT: 'payment',
  PAYMENT_UPGRADE: 'payment_upgrade',
  GUEST_JOIN: 'guest_join',
  GUEST_LEAVE: 'guest_leave',
  ADMIN_ACTION: 'admin_action',
  ERROR: 'error',
  SYSTEM: 'system',
  OVERLAY_UPLOAD: 'overlay_upload',
  OVERLAY_DELETE: 'overlay_delete',
  CRON_JOB: 'cron_job'
};

// Audit log statuses
export const AUDIT_STATUS = {
  SUCCESS: 'success',
  ERROR: 'error',
  PENDING: 'pending',
  CANCELLED: 'cancelled'
};

/**
 * Create an audit log entry
 * @param {Object} params - Audit log parameters
 * @param {string} params.type - Type of audit log (from AUDIT_TYPES)
 * @param {string} params.userId - User ID (optional for anonymous actions)
 * @param {string} params.userEmail - User email
 * @param {string} params.eventId - Event ID (optional)
 * @param {string} params.eventName - Event name (optional)
 * @param {string} params.action - Human-readable action description
 * @param {Object} params.details - Additional details object
 * @param {string} params.status - Status (from AUDIT_STATUS)
 * @param {Object} params.metadata - Additional metadata
 * @param {Object} params.request - Express request object (for IP, user agent)
 */
export const createAuditLog = async (params) => {
  try {
    const {
      type,
      userId = null,
      userEmail = 'anonymous',
      eventId = null,
      eventName = null,
      action,
      details = {},
      status = AUDIT_STATUS.SUCCESS,
      metadata = {},
      request = null
    } = params;

    // Validate required fields
    if (!type || !action) {
      console.error('[AUDIT] Missing required fields:', { type, action });
      return null;
    }

    // Extract request information
    const ipAddress = request?.ip || request?.connection?.remoteAddress || null;
    const userAgent = request?.headers?.['user-agent'] || null;

    const auditLog = {
      timestamp: new Date(),
      type,
      userId,
      userEmail,
      eventId,
      eventName,
      action,
      details,
      status,
      ipAddress,
      userAgent,
      metadata
    };

    // Add to Firestore
    const docRef = await db.collection('audit_logs').add(auditLog);
    
    console.log(`[AUDIT] Created log: ${type} - ${action} (ID: ${docRef.id})`);
    
    return docRef.id;
  } catch (error) {
    console.error('[AUDIT] Error creating audit log:', error);
    return null;
  }
};

/**
 * Get audit logs with filtering and pagination
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of logs to return (default: 50)
 * @param {string} options.type - Filter by type
 * @param {string} options.userId - Filter by user ID
 * @param {string} options.eventId - Filter by event ID
 * @param {string} options.status - Filter by status
 * @param {Date} options.startDate - Start date filter
 * @param {Date} options.endDate - End date filter
 * @param {string} options.search - Search in action and details
 */
export const getAuditLogs = async (options = {}) => {
  try {
    const {
      limit = 50,
      page = 1,
      cursor, // For cursor-based pagination
      type,
      userId,
      eventId,
      status,
      startDate,
      endDate,
      search
    } = options;

    let query = db.collection('audit_logs');

    // Apply filters
    if (type) query = query.where('type', '==', type);
    if (userId) query = query.where('userId', '==', userId);
    if (eventId) query = query.where('eventId', '==', eventId);
    if (status) query = query.where('status', '==', status);
    if (startDate) query = query.where('timestamp', '>=', startDate);
    if (endDate) query = query.where('timestamp', '<=', endDate);

    // Order by timestamp (newest first)
    query = query.orderBy('timestamp', 'desc');

    // OPTIMIZED: Add pagination
    if (cursor) {
      // Cursor-based pagination (more efficient for large datasets)
      query = query.startAfter(cursor);
    } else if (page > 1) {
      // Offset-based pagination (for backward compatibility)
      const offset = (page - 1) * limit;
      query = query.offset(offset);
    }

    // Apply limit
    query = query.limit(limit);

    const snapshot = await query.get();

    if (snapshot.empty) {
      return {
        logs: [],
        pagination: {
          page,
          limit,
          hasMore: false,
          totalLogs: 0,
          nextCursor: null
        }
      };
    }

    let logs = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp.toDate().toISOString()
    }));

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      logs = logs.filter(log => 
        log.action.toLowerCase().includes(searchLower) ||
        log.userEmail.toLowerCase().includes(searchLower) ||
        (log.eventName && log.eventName.toLowerCase().includes(searchLower)) ||
        (log.details && JSON.stringify(log.details).toLowerCase().includes(searchLower))
      );
    }

    // Get next cursor for pagination
    const nextCursor = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;

    // OPTIMIZED: Get total count only if needed (for first page or when explicitly requested)
    let totalLogs = null;
    if (page === 1 || options.includeTotal) {
      try {
        // Create a count query with the same filters
        let countQuery = db.collection('audit_logs');
        if (type) countQuery = countQuery.where('type', '==', type);
        if (userId) countQuery = countQuery.where('userId', '==', userId);
        if (eventId) countQuery = countQuery.where('eventId', '==', eventId);
        if (status) countQuery = countQuery.where('status', '==', status);
        if (startDate) countQuery = countQuery.where('timestamp', '>=', startDate);
        if (endDate) countQuery = countQuery.where('timestamp', '<=', endDate);
        
        const countSnapshot = await countQuery.get();
        totalLogs = countSnapshot.size;
      } catch (countError) {
        console.error('[AUDIT] Error getting total count:', countError);
        // Continue without total count
      }
    }

    return {
      logs,
      pagination: {
        page,
        limit,
        hasMore: snapshot.docs.length === limit,
        totalLogs,
        nextCursor: nextCursor ? nextCursor.id : null,
        // Additional pagination info
        totalPages: totalLogs ? Math.ceil(totalLogs / limit) : null,
        currentPage: page
      }
    };
  } catch (error) {
    console.error('[AUDIT] Error fetching audit logs:', error);
    return {
      logs: [],
      pagination: {
        page: options.page || 1,
        limit: options.limit || 50,
        hasMore: false,
        totalLogs: 0,
        nextCursor: null,
        error: error.message
      }
    };
  }
};

/**
 * Get audit statistics
 */
export const getAuditStats = async () => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [todayLogs, weekLogs, monthLogs, totalLogs] = await Promise.all([
      db.collection('audit_logs').where('timestamp', '>=', oneDayAgo).get(),
      db.collection('audit_logs').where('timestamp', '>=', oneWeekAgo).get(),
      db.collection('audit_logs').where('timestamp', '>=', oneMonthAgo).get(),
      db.collection('audit_logs').get()
    ]);

    // Count by type
    const typeCounts = {};
    const statusCounts = {};

    totalLogs.docs.forEach(doc => {
      const data = doc.data();
      typeCounts[data.type] = (typeCounts[data.type] || 0) + 1;
      statusCounts[data.status] = (statusCounts[data.status] || 0) + 1;
    });

    return {
      totalLogs: totalLogs.size,
      todayLogs: todayLogs.size,
      weekLogs: weekLogs.size,
      monthLogs: monthLogs.size,
      typeCounts,
      statusCounts
    };
  } catch (error) {
    console.error('[AUDIT] Error fetching audit stats:', error);
    return {
      totalLogs: 0,
      todayLogs: 0,
      weekLogs: 0,
      monthLogs: 0,
      typeCounts: {},
      statusCounts: {}
    };
  }
};

// Convenience functions for common audit events
export const auditPhotoUpload = async (userId, userEmail, eventId, eventName, fileName, fileSize, fileType, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.PHOTO_UPLOAD,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Photo uploaded',
    details: {
      fileName,
      fileSize: `${(fileSize / (1024 * 1024)).toFixed(2)}MB`,
      originalSize: fileSize,
      fileType
    },
    status,
    request
  });
};

export const auditPhotoDelete = async (userId, userEmail, eventId, eventName, fileName, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.PHOTO_DELETE,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Photo deleted',
    details: { fileName },
    status,
    request
  });
};

export const auditLogin = async (userId, userEmail, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.LOGIN,
    userId,
    userEmail,
    action: 'User login',
    status,
    request
  });
};

export const auditSignup = async (userId, userEmail, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.SIGNUP,
    userId,
    userEmail,
    action: 'User signup',
    status,
    request
  });
};

export const auditEventCreate = async (userId, userEmail, eventId, eventName, planId, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.EVENT_CREATE,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Event created',
    details: { planId, eventName, userId, userEmail, eventId},
    status,
    request
  });
};

export const auditEventUpdate = async (userId, userEmail, eventId, eventName, changes, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.EVENT_UPDATE,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Event updated',
    details: { changes },
    status,
    request
  });
};

export const auditEventToggle = async (userId, userEmail, eventId, eventName, newStatus, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.EVENT_TOGGLE,
    userId,
    userEmail,
    eventId,
    eventName,
    action: `Event ${newStatus}`,
    details: { newStatus },
    status,
    request
  });
};

export const auditPayment = async (userId, userEmail, eventId, eventName, amount, planId, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.PAYMENT,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Payment processed',
    details: { amount, planId, eventName, userId, userEmail, eventId},
    status,
    request
  });
};

export const auditPaymentUpgrade = async (userId, userEmail, eventId, eventName, upgradeAmount, newPlanId, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.PAYMENT_UPGRADE,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Event upgraded',
    details: { upgradeAmount, newPlanId, eventName, userId, userEmail, eventId},
    status,
    request
  });
};

export const auditGuestJoin = async (userId, userEmail, eventId, eventName, guestEmail, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.GUEST_JOIN,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Guest joined event',
    details: { guestEmail, eventName, userId, userEmail, eventId},
    status,
    request
  });
};

export const auditOverlayUpload = async (userId, userEmail, eventId, eventName, overlayName, fileSize, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.OVERLAY_UPLOAD,
    userId,
    userEmail,
    eventId,
    eventName,
    action: 'Overlay uploaded',
    details: {
      overlayName,
      fileSize: `${(fileSize / (1024 * 1024)).toFixed(2)}MB`,
      originalSize: fileSize
    },
    status,
    request
  });
};

export const auditAdminAction = async (userId, userEmail, action, details, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.ADMIN_ACTION,
    userId,
    userEmail,
    action,
    details,
    status,
    request
  });
};

export const auditCronJob = async (action, details, status, request) => {
  return createAuditLog({
    type: AUDIT_TYPES.CRON_JOB,
    userId: null,
    userEmail: 'system@cron',
    eventId: null,
    eventName: null,
    action,
    details,
    status,
    request,
    metadata: {
      source: 'cron_job',
      automatic: true
    }
  });
};
