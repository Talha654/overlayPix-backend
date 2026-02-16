import { Router } from "express";
import { getAllEvents, toggleEventState } from "../../controllers/admin/EventPage.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

// Apply admin verification to all EventPage routes
router.use(verifyAdmin);

// Get all events for admin dashboard
router.get("/events", getAllEvents);

// Toggle event state (Active/Ended)
router.patch("/events/:eventId/state", toggleEventState);

export default router;
