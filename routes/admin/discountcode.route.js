import { Router } from "express";
import {
  createDiscountCode,
  getAllDiscountCodes,
  getDiscountCode,
  updateDiscountCode,
  deleteDiscountCode,
  validateDiscountCode,
  applyDiscountCode,
  getDiscountCodeStats,
  generateDiscountCode,
  getDiscountCodeUsageHistory
} from "../../controllers/admin/discountcode.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

// Public routes (for frontend validation and application)
router.post("/validate", validateDiscountCode); // Validate discount code
router.post("/apply", applyDiscountCode); // Apply discount code

// Apply admin verification to all discount code routes
router.use(verifyAdmin);

// Admin routes
router.post("/", createDiscountCode); // Create new discount code
router.get("/", getAllDiscountCodes); // Get all discount codes with pagination
router.get("/stats", getDiscountCodeStats); // Get discount code statistics
router.get("/generate", generateDiscountCode); // Generate unique discount code
router.get("/:id", getDiscountCode); // Get single discount code
router.get("/:id/usage", getDiscountCodeUsageHistory); // Get usage history for a code
router.put("/:id", updateDiscountCode); // Update discount code
router.delete("/:id", deleteDiscountCode); // Delete discount code


export default router;
