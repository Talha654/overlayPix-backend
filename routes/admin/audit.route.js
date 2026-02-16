import { Router } from "express";
import { 
    getSystemActivity, 
    getAuditStats2, 
    deleteAuditLog, 
    deleteMultipleAuditLogs, 
    deleteAuditLogsByFilter 
} from "../../controllers/admin/audit.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

// Apply admin verification to all audit routes
router.use(verifyAdmin);

// Get system activity logs
router.get("/activity", getSystemActivity);

// Get audit statistics
router.get("/statistics", getAuditStats2);

// Delete audit log by ID
router.delete("/:auditId", deleteAuditLog);

// Delete multiple audit logs by IDs
router.delete("/bulk/ids", deleteMultipleAuditLogs);

// Delete audit logs by filters (bulk delete)
router.delete("/bulk/filter", deleteAuditLogsByFilter);

export default router;
