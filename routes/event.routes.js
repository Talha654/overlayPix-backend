import express from 'express';
import {
  getEventDashboard,
  getEvents,
  getEventById,
  updateEvent,
  upgradeEvent,
  getEventPhotos,
  getEventGuests,
  createCompleteEvent,
  getUserProfile,
  updateUserProfile,
  getAllPhotosByGuest
} from '../controllers/event.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

// Apply authentication to all event routes
router.use(authenticate);

// User profile routes
router.get('/users/:userId', getUserProfile);
router.put('/users/:userId', upload.fields([
  { name: 'profilePicture', maxCount: 1 }
]), updateUserProfile);
// Dashboard stats
router.get('/dashboard', getEventDashboard);
// List all events for user
router.get('/', getEvents);
// Create complete event (with overlays, payment, etc.)
router.post('/create', upload.fields([
  { name: 'eventPicture', maxCount: 1 },
  { name: 'overlay', maxCount: 1 }
]), createCompleteEvent);
// Get event by ID
router.get('/:id', getEventById);
// Update event by ID (PATCH for partial updates)
router.patch('/:id', upload.fields([
  { name: 'eventPicture', maxCount: 1 },
  { name: 'overlay', maxCount: 1 }
]), updateEvent);
// Upgrade event plan
router.patch('/:id/upgrade', upload.fields([
  { name: 'eventPicture', maxCount: 1 },
  { name: 'overlay', maxCount: 1 }
]), upgradeEvent);
// Get event photos
router.get('/:id/photos', getEventPhotos);
// Get all photos by guest for an event
router.get('/:id/photos/guest/:guestId', getAllPhotosByGuest);
// Get event guests
router.get('/:id/guests', getEventGuests);

export default router;