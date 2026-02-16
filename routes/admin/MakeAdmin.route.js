import { makeAdmin, deleteAdmin } from "../../controllers/admin/MakeAdmin.controller.js";

import { Router } from "express";
import { verifyAdmin } from "../../middlewares/auth.middleware.js";

const router = Router();

// Apply admin verification to all make-admin routes
router.use(verifyAdmin);

router.post("/make-admin",  makeAdmin);
router.post("/delete-admin",  deleteAdmin);

export default router;
