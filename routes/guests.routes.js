import express from 'express';
import {
  updateGuestConsent,
  getGuestPhotos,
  uploadGuestPhoto,
  checkGuestConsent,
  getEventByShareCode,
  getLiveGallery,
  // updateGuestProfile,
  // getGuestProfile,
  getAllPhotosByGuest,
  getGuestEvents,
  likePhoto,
  unlikePhoto,
  togglePhotoLike
} from '../controllers/guests.controller.js';
import { authenticate, authenticateGuest } from '../middlewares/auth.middleware.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

// Public route: Get event by share code
router.get('/share/:shareCode', getEventByShareCode);

// All routes below require authentication (including anonymous)
router.use(authenticateGuest);
// router.use(authenticate)
// Get all events that the guest has joined
router.get('/events', getGuestEvents);

// Live gallery
router.get('/:eventId/live-gallery', getLiveGallery);
// check guest consent
router.get('/:eventId/consent', checkGuestConsent);
// Guest consent
router.post('/share/:shareCode/consent', updateGuestConsent);
// Guest gallery and upload
router.get('/:eventId/photos', getGuestPhotos);
router.get('/:eventId/all-photos/:guestId', getAllPhotosByGuest); // New route for all photos by guest
router.post('/:eventId/photos',  upload.single('photo'), uploadGuestPhoto);

// Photo like functionality
router.post('/:eventId/photos/:photoId/like', likePhoto);
router.delete('/:eventId/photos/:photoId/like', unlikePhoto);
router.post('/:eventId/photos/:photoId/toggle-like', togglePhotoLike);

// Guest profile
// router.get('/:eventId/profile', getGuestProfile);
// router.put('/:eventId/profile', upload.single('profilePicture'), updateGuestProfile);

export default router;
