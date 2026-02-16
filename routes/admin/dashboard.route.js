import { Router } from "express";
import { getAllActiveEvents, getR2Stats } from "../../controllers/admin/dashboard.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";
import { updateExpiredEvents, getCronStatus } from "../../services/cron.service.js";

const router = Router();
router.use(verifyAdmin)
router.get("/active-events", getAllActiveEvents);
router.get("/r2-stats", getR2Stats);

// Cron job endpoints
router.get("/cron/status", getCronStatus);
router.post("/cron/expire-events", async (req, res) => {
  try {
    const result = await updateExpiredEvents();
    res.json({
      success: true,
      message: "Expired events check completed",
      result
    });
  } catch (error) {
    console.error('Manual expired events check failed:', error);
    res.status(500).json({
      success: false,
      message: "Failed to check expired events",
      error: error.message
    });
  }
});

export default router;
