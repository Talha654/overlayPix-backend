import express from 'express';
import multer from 'multer';
import {
  createAdminOverlay,
  getAdminOverlays,
  getAdminOverlayById,
  updateAdminOverlay,
  deleteAdminOverlay,
  getAdminOverlaysByCategory,
  toggleOverlayStatus
} from '../../controllers/admin/overlay.controller.js';
import { authenticate, verifyAdmin } from '../../middlewares/auth.middleware.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// Apply authentication middleware to all overlay routes
router.get('/', authenticate, getAdminOverlays);
router.use(verifyAdmin);

// Create overlay
router.post('/', upload.single('file'), createAdminOverlay);
// Get all overlays
// Get one overlay
router.get('/:id', getAdminOverlayById);
// Get overlays by category
router.get('/category/:category', getAdminOverlaysByCategory);
// Update overlay
router.put('/:id', upload.single('file'), updateAdminOverlay);
// Toggle overlay status
router.patch('/:overlayId/toggle', toggleOverlayStatus);
// Delete overlay
router.delete('/:id', deleteAdminOverlay);

export default router;