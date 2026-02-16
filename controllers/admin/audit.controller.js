import { getAuditLogs, getAuditStats } from "../../services/audit.service.js";
import { successResponse, serverErrorResponse, notFoundResponse, badRequestResponse } from "../../utils/responses.js";
import { db } from "../../services/firebase.service.js";

export const getSystemActivity = async (req, res) => {
  try {
    // Pagination and filter parameters
    const {
      limit = 10,
      cursor,
      direction,
      type,
      userId,
      eventId,
      status,
      startDate,
      endDate,
      search,
      includeTotal = false
    } = req.query;

    // Build base query
    let baseQuery = db.collection("audit_logs")
      .orderBy("timestamp", "desc")
      .orderBy("__name__", "asc");

    if (type) baseQuery = baseQuery.where("type", "==", type);
    if (userId) baseQuery = baseQuery.where("userId", "==", userId);
    if (eventId) baseQuery = baseQuery.where("eventId", "==", eventId);
    if (status) baseQuery = baseQuery.where("status", "==", status);
    if (startDate) baseQuery = baseQuery.where("timestamp", ">=", new Date(startDate));
    if (endDate) baseQuery = baseQuery.where("timestamp", "<=", new Date(endDate));

    const pageLimit = parseInt(limit) || 10;
    const pageLimitPlusOne = pageLimit + 1;

    let queryToRun = baseQuery;

    // If there's a cursor, resolve the document snapshot
    let cursorDocSnap = null;
    if (cursor) {
      try {
        const decodedCursor = JSON.parse(Buffer.from(cursor, "base64").toString());
        const { docId } = decodedCursor;
        if (!docId) throw new Error("cursor missing docId");

        cursorDocSnap = await db.collection("audit_logs").doc(docId).get();
        if (!cursorDocSnap.exists) {
          return serverErrorResponse(res, "Invalid cursor: document not found");
        }
      } catch (err) {
        console.error("Invalid cursor format or fetch error:", err);
        return serverErrorResponse(res, "Invalid cursor format");
      }
    }

    // Handle next vs prev
    if (cursor && direction === "prev") {
      queryToRun = queryToRun.endBefore(cursorDocSnap).limitToLast(pageLimitPlusOne);
    } else if (cursor) {
      queryToRun = queryToRun.startAfter(cursorDocSnap).limit(pageLimitPlusOne);
    } else {
      queryToRun = queryToRun.limit(pageLimitPlusOne);
    }

    const snapshot = await queryToRun.get();

    if (snapshot.empty) {
      return successResponse(res, "System activity logs retrieved successfully.", {
        logs: [],
        pagination: {
          limit: pageLimit,
          hasNextPage: false,
          hasPrevPage: !!cursor,
          nextCursor: null,
          prevCursor: null,
          totalLogs: 0
        }
      });
    }

    // Determine if we fetched an extra doc to detect more pages
    let docs = snapshot.docs.slice();
    const fetchedMore = docs.length > pageLimit;

    // Trim the extra doc
    if (fetchedMore) {
      if (direction === "prev") {
        docs = docs.slice(1); // drop first
      } else {
        docs = docs.slice(0, pageLimit); // drop last
      }
    }

    // Parse logs
    const logs = docs.map(doc => {
      const data = doc.data();
      let timestamp = null;
      if (data.timestamp) {
        if (typeof data.timestamp.toDate === "function") {
          timestamp = data.timestamp.toDate().toISOString();
        } else if (data.timestamp instanceof Date) {
          timestamp = data.timestamp.toISOString();
        } else if (typeof data.timestamp === "string" || typeof data.timestamp === "number") {
          const d = new Date(data.timestamp);
          timestamp = isNaN(d.getTime()) ? null : d.toISOString();
        }
      }
      return {
        id: doc.id,
        ...data,
        timestamp
      };
    });

    // Cursors
    const firstDoc = docs[0];
    const lastDoc = docs[docs.length - 1];
    const makeCursor = (doc) => Buffer.from(JSON.stringify({
      timestamp: doc.data().timestamp?.toDate?.()?.toISOString() || doc.data().timestamp,
      docId: doc.id
    })).toString("base64");

    const firstCursor = firstDoc ? makeCursor(firstDoc) : null;
    const lastCursor = lastDoc ? makeCursor(lastDoc) : null;

    // Compute hasNext/hasPrev
    let hasNextPage = false;
    let hasPrevPage = false;
    if (direction === "prev") {
      hasPrevPage = fetchedMore;
      hasNextPage = !!cursor;
    } else {
      hasNextPage = fetchedMore;
      hasPrevPage = !!cursor;
    }

    // Pagination object
    const pagination = {
      limit: pageLimit,
      hasNextPage,
      hasPrevPage,
      nextCursor: hasNextPage ? lastCursor : null,
      prevCursor: hasPrevPage ? firstCursor : null,
      totalLogs: undefined
    };

    // Total count if requested
    if (includeTotal === "true" || includeTotal === true) {
      let countQuery = db.collection("audit_logs");
      if (type) countQuery = countQuery.where("type", "==", type);
      if (userId) countQuery = countQuery.where("userId", "==", userId);
      if (eventId) countQuery = countQuery.where("eventId", "==", eventId);
      if (status) countQuery = countQuery.where("status", "==", status);
      if (startDate) countQuery = countQuery.where("timestamp", ">=", new Date(startDate));
      if (endDate) countQuery = countQuery.where("timestamp", "<=", new Date(endDate));
      const countSnap = await countQuery.get();
      pagination.totalLogs = countSnap.size;
    } else {
      pagination.totalLogs = logs.length;
    }

    return successResponse(res, "System activity logs retrieved successfully.", {
      logs,
      pagination
    });
  } catch (error) {
    console.error("Error fetching system activity:", error);
    return serverErrorResponse(res, error.message);
  }
};


// OPTIMIZED: Get audit log statistics without fetching full data
export const getAuditStats2 = async (req, res) => {
  try {
    const {
      type,
      userId,
      eventId,
      status,
      startDate,
      endDate
    } = req.query;

    // Create base query with filters
    let query = db.collection('audit_logs');
    if (type) query = query.where('type', '==', type);
    if (userId) query = query.where('userId', '==', userId);
    if (eventId) query = query.where('eventId', '==', eventId);
    if (status) query = query.where('status', '==', status);
    if (startDate) query = query.where('timestamp', '>=', new Date(startDate));
    if (endDate) query = query.where('timestamp', '<=', new Date(endDate));

    // Get total count
    const snapshot = await query.get();
    const totalLogs = snapshot.size;

    // Get activity by type (if no specific type filter)
    let activityByType = {};
    if (!type) {
      const typeQuery = db.collection('audit_logs');
      if (userId) typeQuery.where('userId', '==', userId);
      if (eventId) typeQuery.where('eventId', '==', eventId);
      if (status) typeQuery.where('status', '==', status);
      if (startDate) typeQuery.where('timestamp', '>=', new Date(startDate));
      if (endDate) typeQuery.where('timestamp', '<=', new Date(endDate));
      
      const typeSnapshot = await typeQuery.get();
      typeSnapshot.docs.forEach(doc => {
        const logType = doc.data().type || 'unknown';
        activityByType[logType] = (activityByType[logType] || 0) + 1;
      });
    }

    // Get recent activity count (last 24 hours)
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let recentActivityQuery = db.collection('audit_logs').where('timestamp', '>=', last24Hours);
    if (type) recentActivityQuery = recentActivityQuery.where('type', '==', type);
    if (userId) recentActivityQuery = recentActivityQuery.where('userId', '==', userId);
    if (eventId) recentActivityQuery = recentActivityQuery.where('eventId', '==', eventId);
    if (status) recentActivityQuery = recentActivityQuery.where('status', '==', status);
    
    const recentSnapshot = await recentActivityQuery.get();
    const recentActivity = recentSnapshot.size;

    const stats = {
      totalLogs,
      recentActivity,
      activityByType,
      filters: {
        type: type || null,
        userId: userId || null,
        eventId: eventId || null,
        status: status || null,
        startDate: startDate || null,
        endDate: endDate || null
      }
    };

    return successResponse(res, "Audit statistics retrieved successfully.", stats);
  } catch (error) {
    console.error("Error fetching audit statistics:", error);
    return serverErrorResponse(res, error.message);
  }
};

// Delete a single audit log by ID
export const deleteAuditLog = async (req, res) => {
  try {
    const { auditId } = req.params;

    // Validate audit ID
    if (!auditId) {
      return badRequestResponse(res, "Audit ID is required");
    }

    // Check if the audit log exists
    const auditDoc = await db.collection("audit_logs").doc(auditId).get();
    
    if (!auditDoc.exists) {
      return notFoundResponse(res, "Audit log not found");
    }

    // Get audit data before deletion for logging
    const auditData = auditDoc.data();

    // Delete the audit log
    await db.collection("audit_logs").doc(auditId).delete();

    console.log(`[AUDIT DELETE] Audit log deleted: ${auditId}, Type: ${auditData.type}, User: ${auditData.userId}`);

    return successResponse(res, "Audit log deleted successfully", {
      deletedAuditId: auditId,
      deletedAuditType: auditData.type,
      deletedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("Error deleting audit log:", error);
    return serverErrorResponse(res, error.message);
  }
};

// Delete multiple audit logs by IDs
export const deleteMultipleAuditLogs = async (req, res) => {
  try {
    const { auditIds } = req.body;

    // Validate audit IDs array
    if (!auditIds || !Array.isArray(auditIds) || auditIds.length === 0) {
      return badRequestResponse(res, "Audit IDs array is required and must not be empty");
    }

    // Limit the number of audits that can be deleted at once
    if (auditIds.length > 50) {
      return badRequestResponse(res, "Cannot delete more than 50 audit logs at once");
    }

    const results = [];
    const errors = [];

    // Process each audit ID
    for (const auditId of auditIds) {
      try {
        // Check if the audit log exists
        const auditDoc = await db.collection("audit_logs").doc(auditId).get();
        
        if (!auditDoc.exists) {
          errors.push({
            auditId,
            error: "Audit log not found"
          });
          continue;
        }

        // Get audit data before deletion
        const auditData = auditDoc.data();

        // Delete the audit log
        await db.collection("audit_logs").doc(auditId).delete();

        results.push({
          auditId,
          type: auditData.type,
          userId: auditData.userId,
          status: "deleted"
        });

        console.log(`[AUDIT DELETE] Audit log deleted: ${auditId}, Type: ${auditData.type}`);

      } catch (error) {
        console.error(`Error deleting audit log ${auditId}:`, error);
        errors.push({
          auditId,
          error: error.message
        });
      }
    }

    const response = {
      deletedCount: results.length,
      errorCount: errors.length,
      deletedAudits: results,
      errors: errors.length > 0 ? errors : undefined
    };

    if (errors.length === 0) {
      return successResponse(res, `Successfully deleted ${results.length} audit logs`, response);
    } else if (results.length === 0) {
      return serverErrorResponse(res, "Failed to delete any audit logs", response);
    } else {
      return successResponse(res, `Partially successful: ${results.length} deleted, ${errors.length} failed`, response);
    }

  } catch (error) {
    console.error("Error deleting multiple audit logs:", error);
    return serverErrorResponse(res, error.message);
  }
};

// Delete audit logs by filters (bulk delete)
export const deleteAuditLogsByFilter = async (req, res) => {
  try {
    const {
      type,
      userId,
      eventId,
      status,
      startDate,
      endDate,
      confirm = false
    } = req.body;

    // Require confirmation for bulk delete operations
    if (confirm !== true) {
      return badRequestResponse(res, "Confirmation required for bulk delete operations. Set confirm to true.");
    }

    // Build query to find audit logs to delete
    let query = db.collection("audit_logs");
    if (type) query = query.where("type", "==", type);
    if (userId) query = query.where("userId", "==", userId);
    if (eventId) query = query.where("eventId", "==", eventId);
    if (status) query = query.where("status", "==", status);
    if (startDate) query = query.where("timestamp", ">=", new Date(startDate));
    if (endDate) query = query.where("timestamp", "<=", new Date(endDate));

    // Get all matching audit logs
    const snapshot = await query.get();

    if (snapshot.empty) {
      return notFoundResponse(res, "No audit logs found matching the specified criteria");
    }

    const auditLogs = snapshot.docs;
    const totalCount = auditLogs.length;

    // Limit bulk delete to prevent accidental large deletions
    if (totalCount > 1000) {
      return badRequestResponse(res, `Cannot delete more than 1000 audit logs at once. Found ${totalCount} matching logs.`);
    }

    // Delete all matching audit logs
    const batch = db.batch();
    auditLogs.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    console.log(`[AUDIT BULK DELETE] Deleted ${totalCount} audit logs with filters:`, {
      type, userId, eventId, status, startDate, endDate
    });

    return successResponse(res, `Successfully deleted ${totalCount} audit logs`, {
      deletedCount: totalCount,
      filters: {
        type: type || null,
        userId: userId || null,
        eventId: eventId || null,
        status: status || null,
        startDate: startDate || null,
        endDate: endDate || null
      },
      deletedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("Error deleting audit logs by filter:", error);
    return serverErrorResponse(res, error.message);
  }
};
