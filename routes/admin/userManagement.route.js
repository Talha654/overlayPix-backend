import { Router } from "express";
import { getAllUsers, getUserById, deleteUser } from "../../controllers/admin/userManagement.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

// Apply admin verification to all user management routes
router.use(verifyAdmin);

// Get all users for admin dashboard
router.get("/users", getAllUsers);

// Get specific user by ID
router.get("/users/:userId", getUserById);

// Delete user by ID
router.delete("/users/:userId", deleteUser);

export default router;
