import { Router } from "express";
import { createPricingPlan, getAllPricingPlans, updatePricingPlan, getPricingPlanById, deletePricingPlan } from "../../controllers/admin/pricing-plans.controller.js";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

router.get("/", getAllPricingPlans);
router.get("/:id", getPricingPlanById);
// router.use(verifyAdmin);

router.post("/create", verifyAdmin, createPricingPlan);
router.put("/:id", verifyAdmin, updatePricingPlan);
router.delete("/:id", verifyAdmin, deletePricingPlan);

export default router;
