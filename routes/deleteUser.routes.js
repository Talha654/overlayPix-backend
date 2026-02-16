import { deleteUser2 } from "../controllers/deleteUser.controller.js";

import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";

const router = Router();

// Apply admin verification to all make-admin routes
router.use(authenticate);

router.post("/delete-user",  deleteUser2);


export default router;
