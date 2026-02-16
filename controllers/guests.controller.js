import { db } from '../services/firebase.service.js';
import { DateTime } from 'luxon';
import { r2 } from '../services/r2.service.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import logger from '../services/logger.service.js';
import { auditPhotoUpload, auditGuestJoin, createAuditLog, AUDIT_STATUS, AUDIT_TYPES } from '../services/audit.service.js';

/**
 * Check if storage has expired based on event date and storage days
 * @param {Object} event - Event object with eventDate and plan/customPlan
 * @returns {Object} - { expired: boolean, message?: string }
 */
export const checkStorageExpiration = (event) => {
  if (!event.eventDate) {
    console.log('no eventDate');
    return { expired: false };
  }
  console.log('event', event);
  console.log('event.customPlan', event.customPlan.storageDays);
  // console.log('event.plan', event.plan.storageDays);

  const storageDays = event.customPlan.storageDays // || event.plan?.storageDays // Default 30 days
  console.log('storageDays', storageDays);
  const eventDate = event.eventDate.toDate ? event.eventDate.toDate() : new Date(event.eventDate);
  console.log('eventDate', eventDate);
  const storageExpiryDate = new Date(eventDate.getTime() + (storageDays * 24 * 60 * 60 * 1000));
  const currentDate = new Date();

  console.log('storageExpiryDate', storageExpiryDate);
  console.log('currentDate', currentDate);
  console.log('currentDate > storageExpiryDate', currentDate > storageExpiryDate);
  
  if (currentDate > storageExpiryDate) {
    console.log('storage expired');
    return { 
      expired: true, 
      message: 'Your storage is expired',
      storageDays,
      eventDate: eventDate.toISOString(),
      expiryDate: storageExpiryDate.toISOString()
    };
  }
  
  return { expired: false };
};


// Get event by share code (public/guest access)
export const getEventByShareCode = async (req, res) => {
  try {
    const shareCode = req.params.shareCode;
    const guestId = req.query.guestId;
    const eventsSnap = await db.collection('events').where('shareCode', '==', shareCode).limit(1).get();
    if (eventsSnap.empty) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = eventsSnap.docs[0].data();

    const guestsSnapshot = await db.collection('guests').where('eventId', '==', event.eventId).count().get();
    const currentGuestCount = guestsSnapshot.data().count || 0;
    const guestLimit = event.customPlan?.guestLimit || event.plan?.guestLimit || 50;

    console.log('currentGuestCount', currentGuestCount);
    console.log('guestLimit', guestLimit);

    // Format event date
    let eventDate = '';
    if (event.eventDate && event.timeZone && event.eventDate.toDate) {
      eventDate = DateTime.fromJSDate(event.eventDate.toDate(), { zone: event.timeZone })
        .toFormat('yyyy-MM-dd HH:mm:ssZZ');
    } else if (event.eventDate && event.eventDate.toDate) {
      eventDate = event.eventDate.toDate().toISOString();
    }

    // --- Calculate event status (active/expired) ---
    let eventStatus = 'active';

          const nowInEventTZ = DateTime.utc().minus({ hours: 4 });
                if (nowInEventTZ > event.eventEndDate?.toDate()) {
                  console.log('Datenow',DateTime.now().toJSDate());
                  console.log(DateTime.now().setZone("America/New_York").offset);
                  console.log('Event is expired based on current time:', nowInEventTZ.toJSDate());
                  console.log('Event is expired based on eventEndDate:', event.eventEndDate?.toDate());
                  console.log('Event is expired based on eventEndDate:', event.eventEndDate?.ts);
                  eventStatus = 'expired';
                  // expires = true;
                } else{
                  console.log('Event is still active based on current time:', nowInEventTZ.ts);
                  console.log('Event is still active based on current time toISO:', nowInEventTZ.toISO());
                  console.log(DateTime.now().setZone("America/New_York").offset);
                  console.log('Event is still active based on current time toISO:', nowInEventTZ);
                  console.log('Event is still active based on eventEndDate toDate:', event.eventEndDate?.toDate());
                  console.log('Event is still active based on eventEndDate:', event.eventEndDate?.toMillis());
                  console.log('Event is still active based on eventEndDate toISO:', event.eventEndDate?.toDate().toISOString());

                  eventStatus = 'active';
                  // expires = false;
                }
    // try {

      
    //   // Parse event date to ISO string (from Firestore Timestamp, ISO, or _seconds)
    //   let eventDateISO;
    //   if (event.eventDate && typeof event.eventDate === 'object' && typeof event.eventDate.toDate === 'function') {
    //     // Firestore Timestamp object
    //     eventDateISO = event.eventDate.toDate().toISOString();
    //   } else if (event.eventDate && !isNaN(Date.parse(event.eventDate))) {
    //     // ISO string or date string
    //     eventDateISO = new Date(event.eventDate).toISOString();
    //   } else if (event.eventDate && typeof event.eventDate._seconds === 'number') {
    //     // Possibly a plain Timestamp-like object
    //     eventDateISO = new Date(event.eventDate._seconds * 1000).toISOString();
    //   } else {
    //     eventDateISO = new Date().toISOString(); // fallback to now (should not happen)
    //   }

    //   // Default to 23:59 if no end time
    //   let endTimeStr = event.eventEndTime && typeof event.eventEndTime === 'string'
    //     ? event.eventEndTime
    //     : '23:59';

    //   // Parse hours and minutes
    //   let [hours, minutes] = endTimeStr.split(':').map(Number);
    //   if (isNaN(hours) || isNaN(minutes)) {
    //     hours = 23;
    //     minutes = 59;
    //   }

    //   // Use luxon to combine date and time in the event's time zone
    //   const eventTimeZone = event.timeZone || 'local';
    //   let eventDateObj = DateTime.fromISO(eventDateISO, { zone: eventTimeZone });
    //   let eventEndDateTime = eventDateObj.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

    //   // Now, compare current time in the event's time zone
    //   const nowInEventTZ = DateTime.now().setZone(eventTimeZone);

    //   if (nowInEventTZ > eventEndDateTime) {
    //     eventStatus = 'expired';
    //   }
    // } catch (e) {
    //   // If any error in calculation, default to 'active'
    //   eventStatus = 'active';
    // }
    // --- End event status calculation ---

    // Get owner name from users collection
    let ownerName = 'Event Owner';
    try {
      const userSnap = await db.collection('users').doc(event.userId).get();
      if (userSnap.exists) {
        const userData = userSnap.data();
        ownerName = userData.fullName 
      }
    } catch (e) {}

    // Guest info
    // Use customPlan if available, else fallback to plan
    let photosPerGuest = event.customPlan?.photosPerGuest || event.plan?.photosPerGuest || 0;
    let guestPicturesMax = photosPerGuest;
    let guestPicturesLeft = photosPerGuest;
    let termsAccepted = false;
    let isEventOwner = false;
    
    if (guestId) {
      // Check if user is event owner first
      isEventOwner = event.userId === guestId;
      
      if (isEventOwner) {
        // Event owners don't need to accept terms and have unlimited photos
        termsAccepted = true;
         // Unlimited for event owners
      } else {
        // Regular guest - check guest record
        const guestSnap = await db.collection('guests')
          .where('eventId', '==', event.eventId)
          .where('guestId', '==', guestId)
          .limit(1).get();
        if (!guestSnap.empty) {
          const guest = guestSnap.docs[0].data();
          // guestPicturesLeft = max - uploaded
          guestPicturesLeft = guestPicturesMax - (guest.photosUploaded || 0);
          if (guestPicturesLeft < 0) guestPicturesLeft = 0;
          termsAccepted = !!guest.termsAccepted;
        }
      }
    }

    res.json({
      currentGuestCount,
      guestLimit,
      eventId: event.eventId,
      eventName: event.name,
      ownerName,
      eventPictureUrl: event.eventPictureUrl,
      eventDate,
      guestPicturesLeft,
      guestPicturesMax,
      termsAccepted,
      isEventOwner,
      overlayId: event.overlayId || null,
      overlayUrl: typeof event.overlayUrl !== 'undefined' ? event.overlayUrl : null,
      typography: event.typography,
      fontStyle: event.fontStyle,
      fontSize: event.fontSize,
      brandColor: event.brandColor,
      customPlan: event.customPlan || null, // <-- Added custom plan details
      eventStatus, // <-- Added event status (active/expired)
      // termsUrl: 'https://yourapp.com/terms',
      // privacyUrl: 'https://yourapp.com/privacy'
    });
  } catch (error) {
    console.error('Get Event By Share Code Error:', error);
    
    // Audit log: GET event by share code failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: null,
      eventName: null,
      action: 'Get event by share code failed',
      details: {
        shareCode: req.params.shareCode,
        guestId: req.query.guestId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch event by share code', message: error.message });
  }
};

// POST endpoint to update guest consent
export const updateGuestConsent = async (req, res) => {
  try {
    const shareCode = req.params.shareCode;
    const guestId = req.user.uid; // Use authenticated user's UID

    // Find event by share code
    const eventsSnap = await db.collection('events').where('shareCode', '==', shareCode).limit(1).get();
    if (eventsSnap.empty) return res.status(404).json({ error: 'Event not found' });
    const event = eventsSnap.docs[0].data();

    // console.log('event', event);

    // --- Add event status and guest limit checks (like in file_context_0) ---

    // Check if event is active (not expired)
    // Properly handle Firestore Timestamp for event.eventDate and combine with event.eventEndTime
    // Now: Combine using event.timeZone (if available) to ensure correct local time

    // Use luxon for robust timezone handling

     let eventStatus = 'active';

          const nowInEventTZ = DateTime.utc().minus({ hours: 4 });
                if (nowInEventTZ > event.eventEndDate?.toDate()) {
                  console.log('Datenow',DateTime.now().toJSDate());
                  console.log(DateTime.now().setZone("America/New_York").offset);
                  console.log('Event is expired based on current time:', nowInEventTZ.toJSDate());
                  console.log('Event is expired based on eventEndDate:', event.eventEndDate?.toDate());
                  console.log('Event is expired based on eventEndDate:', event.eventEndDate?.ts);
                  return res.status(400).json({ error: 'Event has ended' });
                  eventStatus = 'expired';
                  // expires = true;
                } else{
                  console.log('Event is still active based on current time:', nowInEventTZ.ts);
                  console.log('Event is still active based on current time toISO:', nowInEventTZ.toISO());
                  console.log(DateTime.now().setZone("America/New_York").offset);
                  console.log('Event is still active based on current time toISO:', nowInEventTZ);
                  console.log('Event is still active based on eventEndDate toDate:', event.eventEndDate?.toDate());
                  console.log('Event is still active based on eventEndDate:', event.eventEndDate?.toMillis());
                  console.log('Event is still active based on eventEndDate toISO:', event.eventEndDate?.toDate().toISOString());

                  eventStatus = 'active';
                  // expires = false;
                }
    

    // let eventEndDateTime;

    // // Get event time zone, fallback to system if not present
    // const eventTimeZone = event.timeZone || 'local';

    // console.log('event.eventDate', event.eventDate);

    // // Parse event date to ISO string (from Firestore Timestamp, ISO, or _seconds)
    // let eventDateISO;
    // if (event.eventDate && typeof event.eventDate === 'object' && typeof event.eventDate.toDate === 'function') {
    //   // Firestore Timestamp object
    //   eventDateISO = event.eventDate.toDate().toISOString();
    //   console.log('first if eventDateISO', eventDateISO);
    // } else if (event.eventDate && !isNaN(Date.parse(event.eventDate))) {
    //   // ISO string or date string
    //   eventDateISO = new Date(event.eventDate).toISOString();
    //   console.log('second if eventDateISO', eventDateISO);
    // } else if (event.eventDate && typeof event.eventDate._seconds === 'number') {
    //   // Possibly a plain Timestamp-like object
    //   eventDateISO = new Date(event.eventDate._seconds * 1000).toISOString();
    //   console.log('third if eventDateISO', eventDateISO);
    // } else {
    //   eventDateISO = new Date().toISOString(); // fallback to now (should not happen)
    //   console.log('else eventDateISO', eventDateISO);
    // }

    // // Default to 23:59 if no end time
    // let endTimeStr = event.eventEndTime && typeof event.eventEndTime === 'string'
    //   ? event.eventEndTime
    //   : '23:59';

    // // Parse hours and minutes
    // let [hours, minutes] = endTimeStr.split(':').map(Number);
    // if (isNaN(hours) || isNaN(minutes)) {
    //   hours = 23;
    //   minutes = 59;
    // }

    // // Use luxon to combine date and time in the event's time zone
    // let eventDateObj = DateTime.fromISO(eventDateISO, { zone: eventTimeZone });
    // eventEndDateTime = eventDateObj.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

    // console.log('eventEndDateTime', eventEndDateTime);

    // // Now, compare current time in the event's time zone
    // const nowInEventTZ = DateTime.now().setZone(eventTimeZone);

    // if (nowInEventTZ > eventEndDateTime) {
    //   console.log('nowInEventTZ', nowInEventTZ);
    //   console.log('eventEndDateTime', eventEndDateTime);
    //   return res.status(400).json({ error: 'Event has ended' });
    // }

    // Check if guest limit is reached
    const guestsSnapshot = await db.collection('guests').where('eventId', '==', event.eventId).count().get();
    const currentGuestCount = guestsSnapshot.data().count || 0;
    const guestLimit = event.customPlan?.guestLimit || event.plan?.guestLimit || 50;

    console.log('currentGuestCount', currentGuestCount);
    console.log('guestLimit', guestLimit);

    // Only check limit if guest is not already in the list (so updating consent doesn't block existing guests)
    let isNewGuest = false;
    const guestSnap = await db.collection('guests')
      .where('eventId', '==', event.eventId)
      .where('guestId', '==', guestId)
      .limit(1).get();
    if (guestSnap.empty) {
      isNewGuest = true;
      if (currentGuestCount >= guestLimit) {
        return res.status(400).json({ error: 'Event guest limit reached' });
      }
    }
    
    // --- End checks ---

    let userName = '';
    try {
      // Try to get the user's name from the users collection
      const userDoc = await db.collection('users').doc(guestId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        userName = userData.fullName || userData.name || userData.email || '';
      } else {
        // fallback to req.user if available
        userName = req.user.displayName || req.user.name || req.user.email || '';
      }
    } catch (e) {
      // fallback to req.user if error
      userName = req.user.displayName || req.user.name || req.user.email || '';
    }

    if (isNewGuest) {
      // Create guest doc if not exists, include name field
      await db.collection('guests').add({
        eventId: event.eventId,
        guestId,
        name: userName,
        termsAccepted: true,
        photosUploaded: 0,
        isAnonymous: req.user.isAnonymous, // Track if user is anonymous
        createdAt: new Date()
      });
    } else {
      // Update consent
      await db.collection('guests').doc(guestSnap.docs[0].id).update({ 
        termsAccepted: true,
        isAnonymous: req.user.isAnonymous // Update anonymous status
      });
    }

    // Audit log: Guest consent updated
    await auditGuestJoin(
      req.user.uid,
      req.user.email || 'anonymous@guest',
      event.eventId,
      event.name,
      req.user.email || 'anonymous@guest',
      AUDIT_STATUS.SUCCESS,
      req
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Update Guest Consent Error:', error);

    // Audit log: Guest consent update failed
    await auditGuestJoin(
      req.user?.uid || null,
      req.user?.email || 'anonymous@guest',
      event?.eventId || null,
      event?.name || null,
      req.user?.email || 'anonymous@guest',
      AUDIT_STATUS.ERROR,
      req,
      {
        error: error.message
      }
    );

    res.status(500).json({ error: 'Failed to update guest consent' });
  }
};

export const checkGuestConsent = async (req, res) => {
    try {
      const { eventId } = req.params;
      const guestId = req.user.uid; // Use authenticated user's UID
      
      // Get event details first to check if user is event owner
      const eventDoc = await db.collection('events').doc(eventId).get();
      if (!eventDoc.exists) {
        return res.status(404).json({ error: 'Event not found' });
      }
      const event = eventDoc.data();
      
      // Check if user is event owner - if so, return consented: true
      const isEventOwner = event.userId === guestId;
      if (isEventOwner) {
        return res.json({ 
          consented: true, 
          isEventOwner: true,
          message: 'Event owner - no terms acceptance required'
        });
      }
      
      const guestSnap = await db.collection('guests')
        .where('eventId', '==', eventId)
        .where('guestId', '==', guestId)
        .limit(1).get();
      if (guestSnap.empty) {
        return res.json({ consented: false });
      }
      const guest = guestSnap.docs[0].data();
      res.json({ consented: !!guest.termsAccepted, guest });
      } catch (error) {
    // Audit log: Check guest consent failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.eventId,
      eventName: null,
      action: 'Check guest consent failed',
      details: {
        eventId: req.params.eventId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });
    
    res.status(500).json({ error: 'Failed to check guest consent' });
  }
  };

// Get photos uploaded by a guest for an event, also include event name, photo count, allowed photos per guest, overlayUrl, shareId,
// total photo pool for the event, and current photos taken by all guests in that event
export const getGuestPhotos = async (req, res) => {
  try {
    const { eventId } = req.params;
    const guestId = req.user.uid; // Use authenticated user's UID

    // Get event details first to check if user is event owner
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) return res.status(404).json({ error: 'Event not found' });
    const event = eventDoc.data();
    
    // Check if user is event owner - if so, bypass terms acceptance
    const isEventOwner = event.userId === guestId;
    
    // Check guest consent (skip if event owner)
    if (!isEventOwner) {
      const guestSnap = await db.collection('guests')
        .where('eventId', '==', eventId)
        .where('guestId', '==', guestId)
        .limit(1).get();
      if (guestSnap.empty) return res.status(403).json({ error: 'Guest not found' });
      const guest = guestSnap.docs[0].data();
      if (!guest.termsAccepted) return res.status(403).json({ error: 'Consent not accepted' });
    }

    // Check storage days expiration
    const storageCheck = checkStorageExpiration(event);
    if (storageCheck.expired) {
      return res.status(403).json({ error: storageCheck.message });
    }

    // Get event details (for name, allowed photos per guest, overlayUrl, shareId, and photo pool)
    let eventName = '';
    let allowedPhotosPerGuest; // default fallback
    let overlayUrl = null;
    let shareId = null;
    let totalPhotoPool = null;
    if (eventDoc.exists) {
      const eventData = eventDoc.data();
      eventName = eventData.name || '';
      allowedPhotosPerGuest = eventData?.customPlan?.photosPerGuest 
        ?? eventData?.plan?.photosPerGuest;
      overlayUrl = eventData.overlayUrl || null;
      shareId = eventData.shareId || eventData.shareCode || null; // Try both for compatibility
      totalPhotoPool = eventData?.customPlan?.photoPool ?? eventData?.plan?.photoPool ?? null;
    }

    // Get photos uploaded by this guest
    const photosSnap = await db.collection('photos')
      .where('eventId', '==', eventId)
      .where('guestId', '==', guestId)
      .get();
    // Sort photos by createdAt descending (latest first)
    const photos = photosSnap.docs
      .map(doc => {
        const photoData = doc.data();
        // Add isLiked field for current user
        const likes = photoData.likes || [];
        return {
          ...photoData,
          isLiked: likes.includes(guestId)
        };
      })
      .sort((a, b) => {
        // If createdAt is a Firestore Timestamp, convert to Date
        const aTime = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const bTime = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return bTime - aTime;
      });

    // Get total photos taken by all guests in this event
    // Use Firestore count() aggregation if available, else fallback to fetching and counting
    let currentPhotoCount = 0;
    try {
      // Firestore count() aggregation (preferred, if supported)
      if (typeof db.collection('photos').where('eventId', '==', eventId).count === 'function') {
        const allPhotosCountSnap = await db.collection('photos')
          .where('eventId', '==', eventId)
          .count()
          .get();
        currentPhotoCount = allPhotosCountSnap.data().count || 0;
      } else {
        // Fallback: fetch all photo docs for the event and count
        const allPhotosSnap = await db.collection('photos')
          .where('eventId', '==', eventId)
          .get();
        currentPhotoCount = allPhotosSnap.size;
      }
    } catch (err) {
      // If any error, fallback to 0
      currentPhotoCount = 0;
    }

    res.json({ 
      eventName, 
      photoCount: photos.length, 
      allowedPhotosPerGuest,
      overlayUrl,
      shareId,
      totalPhotoPool,
      currentPhotoCount,
      photos 
    });
  } catch (error) {
    console.error('Get Guest Photos Error:', error);
    
    // Audit log: Get guest photos failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.eventId,
      eventName: null,
      action: 'Get guest photos failed',
      details: {
        eventId: req.params.eventId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });
    
    res.status(500).json({ error: 'Failed to fetch guest photos', details: error.message });
  }
};

// Upload photo captured by guest
export const uploadGuestPhoto = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { caption, overlayId } = req.body;

    // Check if user is authenticated (guest or registered user)
    if (!req.user || !req.user.uid) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if photo file is uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'Photo file is required' });
    }

    // Get event details
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventDoc.data();

    // Check if user is event owner - if so, bypass terms acceptance
    const isEventOwner = event.userId === req.user.uid;

    // Check if event is active (not expired)

     const nowInEventTZ = DateTime.utc().minus({ hours: 4 });
                if (nowInEventTZ > event.eventEndDate?.toDate()) {
                   return res.status(400).json({ error: 'Event has ended' });
                }


    // const eventEndDate = new Date(event.eventDate);
    // eventEndDate.setHours(parseInt(event.eventEndTime.split(':')[0]), parseInt(event.eventEndTime.split(':')[1]));

    // if (new Date() > eventEndDate) {
    //   return res.status(400).json({ error: 'Event has ended' });
    // }
    
    // Check if guest limit is reached
    // const guestsSnapshot = await db.collection('events').doc(eventId).collection('guests').get();
    // const currentGuestCount = guestsSnapshot.size;
    
    // const guestLimit = event.customPlan?.guestLimit || event.plan?.guestLimit || 50;
    // if (currentGuestCount >= guestLimit) {
    //   return res.status(400).json({ error: 'Event guest limit reached' });
    // }
    
    // Check if photo pool limit is reached
    const photosSnapshot = await db.collection('events').doc(eventId).collection('photos').count().get();
    const currentPhotoCount = photosSnapshot.data().count || 0;

    const photoPool = event.customPlan?.photoPool || event.plan?.photoPool || 100;
    if (currentPhotoCount >= photoPool) {
      return res.status(400).json({ error: 'Event photo pool limit reached' });
    }

    // Check if guest has reached their photo limit (only if customPlan.photosPerGuest is set and not empty/null)
    let skipPhotoLimitCheck = false;
    let photosPerGuest = 5; // default fallback

    if (
      typeof event.customPlan !== 'undefined' &&
      (
        typeof event.customPlan.photosPerGuest === 'undefined' ||
        event.customPlan.photosPerGuest === null ||
        event.customPlan.photosPerGuest === ''
      )
    ) {
      // If customPlan exists but photosPerGuest is missing, null, or empty string, skip the check
      skipPhotoLimitCheck = true;
    } else if (
      typeof event.customPlan !== 'undefined' &&
      typeof event.customPlan.photosPerGuest !== 'undefined'
    ) {
      photosPerGuest = event.customPlan.photosPerGuest;
    } else if (
      typeof event.plan !== 'undefined' &&
      typeof event.plan.photosPerGuest !== 'undefined'
    ) {
      photosPerGuest = event.plan.photosPerGuest;
    }

    let guestPhotoCount;

    // Skip photo limit check for event owners
    if (!skipPhotoLimitCheck && !isEventOwner) {
      const guestPhotosSnapshot = await db.collection('events').doc(eventId).collection('photos')
        .where('guestId', '==', req.user.uid).get();
      guestPhotoCount = guestPhotosSnapshot.size;

      if (guestPhotoCount >= photosPerGuest) {
        return res.status(400).json({ error: 'You have reached your photo limit for this event' });
      }
    }

    // Generate unique photo ID
    const photoId = db.collection('events').doc(eventId).collection('photos').doc().id;

    // Upload photo to Cloudflare R2
    const photoFile = req.file;
    const photoFileName = `events/${eventId}/photos/${photoId}/photo-${Date.now()}.jpg`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: photoFileName,
      Body: photoFile.buffer,
      ContentType: photoFile.mimetype,
    }));

    // Get photo URL
    const photoUrl = getR2PublicUrl(photoFileName);

    // Fetch guest's full name from users collection
    let guestName = 'Anonymous Guest';
    try {
      const userDoc = await db.collection('users').doc(req.user.uid).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData && userData.fullName) {
          guestName = userData.fullName;
        }
      }
    } catch (err) {
      // If any error, fallback to Anonymous Guest
      guestName = 'Anonymous Guest';
    }

    // Save photo details to Firestore
    const photoData = {
      id: photoId,
      eventId,
      guestId: req.user.uid,
      guestName,
      photoUrl,
      // fileName: photoFileName,
      // caption: caption || '',
      overlayId: overlayId || null,
      isAnonymous: req.user.isAnonymous || false,
      likes: [],
      likeCount: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('events').doc(eventId).collection('photos').doc(photoId).set(photoData);

    // Also save to main photos collection for easier querying
    await db.collection('photos').doc(photoId).set({
      ...photoData,
      eventShareCode: event.shareCode,
      eventName: event.name
    });

    // --- Update guest's photosUploaded count in the guests collection ---
    // Find the guest doc for this event and guestId
    const guestSnap = await db.collection('guests')
      .where('eventId', '==', eventId)
      .where('guestId', '==', req.user.uid)
      .limit(1).get();
    if (!guestSnap.empty) {
      const guestDoc = guestSnap.docs[0];
      const guestData = guestDoc.data();
      const currentPhotosUploaded = guestData.photosUploaded || 0;
      await db.collection('guests').doc(guestDoc.id).update({
        photosUploaded: currentPhotosUploaded + 1
      });
    }
    // --- End update ---

    // Audit log: Photo upload
    await auditPhotoUpload(
      req.user.uid,
      req.user.email || 'anonymous@guest',
      eventId,
      event.name,
      photoFileName,
      photoFile.size,
      photoFile.mimetype,
      AUDIT_STATUS.SUCCESS,
      req
    );

    // Log activity
    logger.info(`Photo uploaded by guest ${req.user.uid} for event ${eventId}`, {
      userId: req.user.uid,
      eventId,
      photoId,
      isAnonymous: req.user.isAnonymous
    });

    res.status(201).json({
      success: true,
      photo: {
        id: photoId,
        photoUrl,
        caption: photoData.caption,
        createdAt: photoData.createdAt,
        likeCount: 0
      },
      limits: {
        guestPhotoCount: (typeof guestPhotoCount === 'number' ? guestPhotoCount + 1 : 1),
        photosPerGuest,
        eventPhotoCount: currentPhotoCount + 1,
        photoPool
      }
    });

  } catch (error) {
    // Audit log: Photo upload failed
    if (req.user?.uid) {
      await auditPhotoUpload(
        req.user.uid,
        req.user.email || 'anonymous@guest',
        req.params.eventId,
        'Unknown Event',
        req.file?.originalname || 'unknown.jpg',
        req.file?.size || 0,
        req.file?.mimetype || 'image/jpeg',
        AUDIT_STATUS.ERROR,
        req
      );
    }

    console.error('Error uploading guest photo:', error);
    logger.error('Failed to upload guest photo', {
      userId: req.user?.uid,
      eventId: req.params.eventId,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to upload photo', details: error.message });
  }
};

// Helper function to construct R2 public URL
function getR2PublicUrl(key) {
  const endpoint = `${process.env.R2_PUBLIC_DOMAIN}/${process.env.R2_BUCKET}/${key}`;
  return endpoint;
}

// Update guest profile (name, email, profile picture)
// export const updateGuestProfile = async (req, res) => {
//   try {
//     const { eventId } = req.params;
//     const guestId = req.user.uid; // Use authenticated user's UID
//     const { name, email } = req.body;
//     const updateData = {};
//     if (name !== undefined) updateData.name = name;
//     if (email !== undefined) updateData.email = email;
//     if (req.file) {
//       const file = req.file;
//       const fileName = `guest_profiles/${eventId}/${guestId}-${Date.now()}.png`;
//       await r2.send(new PutObjectCommand({
//         Bucket: process.env.R2_BUCKET,
//         Key: fileName,
//         Body: file.buffer,
//         ContentType: file.mimetype,
//       }));
//       updateData.profilePictureUrl = `https://${process.env.R2_BUCKET}.${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;
//     }
//     // Update guest doc
//     const guestSnap = await db.collection('guests')
//       .where('eventId', '==', eventId)
//       .where('guestId', '==', guestId)
//       .limit(1).get();
//     let guestDocId;
//     if (guestSnap.empty) {
//       // Create guest doc if not exists
//       const docRef = await db.collection('guests').add({
//         eventId,
//         guestId,
//         ...updateData,
//         termsAccepted: false,
//         photosUploaded: 0,
//         isAnonymous: req.user.isAnonymous, // Track if user is anonymous
//         createdAt: new Date()
//       });
//       guestDocId = docRef.id;
//     } else {
//       guestDocId = guestSnap.docs[0].id;
//       await db.collection('guests').doc(guestDocId).update({
//         ...updateData,
//         isAnonymous: req.user.isAnonymous // Update anonymous status
//       });
//     }
//     // Fetch updated guest
//     const updatedGuestSnap = await db.collection('guests').doc(guestDocId).get();
//     res.json({ success: true, guest: updatedGuestSnap.data() });
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to update guest profile' });
//   }
// };

// Get all photos for an event, sorted by latest photo upload, with security checks
export const getLiveGallery = async (req, res) => {
  try {
    const { eventId } = req.params;
    const guestId = req.user.uid; // Use authenticated user's UID

    // Get event and check permission first
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) return res.status(404).json({ error: 'Event not found' });
    const event = eventDoc.data();
    
    // Check if user is event owner - if so, bypass terms acceptance
    const isEventOwner = event.userId === guestId;
    
    // Check guest consent (skip if event owner)
    if (!isEventOwner) {
      const guestSnap = await db.collection('guests')
        .where('eventId', '==', eventId)
        .where('guestId', '==', guestId)
        .limit(1).get();
      if (guestSnap.empty) {
        return res.status(403).json({ error: 'Guest not found' });
      }
      const guest = guestSnap.docs[0].data();
      if (!guest.termsAccepted) {
        return res.status(403).json({ error: 'Consent not accepted' });
      }
    }

    // Check storage days expiration
    const storageCheck = checkStorageExpiration(event);
    if (storageCheck.expired) {
      return res.status(403).json({ error: storageCheck.message });
    }

    if (!event.customPlan?.permissions?.canViewGallery) {
      return res.status(403).json({ error: 'Live gallery is not enabled for this event' });
    }

    // Get all guests for the event
    const guestsSnap = await db.collection('guests').where('eventId', '==', eventId).get();
    const guestIds = guestsSnap.docs.map(doc => doc.data().guestId || doc.id);
    const guestCount = guestIds.length;

    // Get event name
    const eventName = event.name || '';

    if (guestIds.length === 0) {
      return res.json({
        photos: [],
        photoCount: 0,
        guestCount: 0,
        eventName
      });
    }

    // Get all photos for the event, ordered by createdAt descending (latest first)
    const photosSnap = await db
      .collection('photos')
      .where('eventId', '==', eventId)
      .orderBy('createdAt', 'desc')
      .get();

    // Add isLiked field for current user to each photo
    const allPhotos = photosSnap.docs
      .map(doc => {
        const photo = doc.data();
        if (!photo.guestId) return null; // skip if no guestId
        const likes = photo.likes || [];
        return {
          ...photo,
          isLiked: likes.includes(guestId)
        };
      })
      .filter(Boolean);

    res.json({
      photos: allPhotos,
      photoCount: allPhotos.length,
      guestCount,
      eventName
    });
  } catch (error) {
    console.error('Get Live Gallery Error:', error);
    
    // Audit log: Get live gallery failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.eventId,
      eventName: null,
      action: 'Get live gallery failed',
      details: {
        eventId: req.params.eventId,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch live gallery', details: error.message });
  }
};

// export const getGuestProfile = async (req, res) => {
//   try {
//     const { eventId } = req.params;
//     const guestId = req.user.uid; // Use authenticated user's UID
//     const guestSnap = await db.collection('guests')
//       .where('eventId', '==', eventId)
//       .where('guestId', '==', guestId)
//       .limit(1).get();
//     if (guestSnap.empty) return res.status(404).json({ error: 'Guest not found' });
//     const guest = guestSnap.docs[0].data();
//     res.json(guest);
//   } catch (error) {
//     // Audit log: Get guest profile failed
//     await createAuditLog({
//       type: AUDIT_TYPES.ERROR,
//       userId: req.user?.uid || null,
//       userEmail: req.user?.email || 'anonymous@guest',
//       eventId: req.params.eventId,
//       eventName: null,
//       action: 'Get guest profile failed',
//       details: {
//         eventId: req.params.eventId,
//         error: error.message
//       },
//       status: AUDIT_STATUS.ERROR,
//       request: req
//     });
    
//     res.status(500).json({ error: 'Failed to fetch guest profile' });
//   }
// };



// Get all photos by guest for an event, sorted by latest uploaded photo
export const getAllPhotosByGuest = async (req, res) => {
  try {
    const { eventId, guestId: guestIdParam } = req.params;
    const guestId = guestIdParam || req.user.uid; // Use guestId from params if provided, otherwise authenticated user's UID

    // Get event details first to check if user is event owner
    const eventDoc = await db.collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventDoc.data();

    // Check if user is event owner - if so, bypass terms acceptance
    const isEventOwner = event.userId === guestId;

    let guest = null;
    // Check guest consent (skip if event owner)
    if (!isEventOwner) {
      const guestSnap = await db.collection('guests')
        .where('eventId', '==', eventId)
        .where('guestId', '==', guestId)
        .limit(1).get();

      if (guestSnap.empty) {
        return res.status(403).json({ error: 'Guest not found or not registered for this event' });
      }

      guest = guestSnap.docs[0].data();
      if (!guest.termsAccepted) {
        return res.status(403).json({ error: 'Consent not accepted' });
      }
    } else {
      // If event owner, create a dummy guest object for response
      guest = {
        name: 'Event Owner',
        photosUploaded: 0
      };
    }

    // Check storage days expiration
    const storageCheck = checkStorageExpiration(event);
    if (storageCheck.expired) {
      return res.status(403).json({ error: storageCheck.message });
    }

    // Check if event is still active (not expired)
    const eventEndDate = new Date(event.eventDate);
    if (event.eventEndTime) {
      eventEndDate.setHours(
        parseInt(event.eventEndTime.split(':')[0]),
        parseInt(event.eventEndTime.split(':')[1])
      );
    }

    if (new Date() > eventEndDate) {
      return res.status(400).json({ error: 'Event has ended' });
    }

    // Get all photos for the event and guest, ordered by createdAt descending
    const photosSnap = await db
      .collection('photos')
      .where('eventId', '==', eventId)
      .where('guestId', '==', guestId)
      .orderBy('createdAt', 'desc')
      .get();

    const photos = photosSnap.docs.map(doc => {
      const photoData = doc.data();
      // Add isLiked field for current user
      const likes = photoData.likes || [];
      return {
        ...photoData,
        photoId: doc.id,
        isLiked: likes.includes(req.user.uid)
      };
    });

    // Add guest info to response
    const photosPerGuest = event.customPlan?.photosPerGuest || event.plan?.photosPerGuest || 5;
    const photosUploaded = guest.photosUploaded || 0;
    const response = {
      photos,
      guestInfo: {
        name: guest.name || (isEventOwner ? 'Event Owner' : 'Anonymous Guest'),
        photosUploaded: photosUploaded,
        photosPerGuest: photosPerGuest,
        remainingPhotos: Math.max(0, photosPerGuest - photosUploaded)
      },
      eventInfo: {
        name: event.name,
        eventDate: event.eventDate,
        eventEndTime: event.eventEndTime
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Get All Photos By Guest Error:', error);

    // Audit log: Get all photos by guest failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: req.params.eventId,
      eventName: null,
      action: 'Get all photos by guest failed',
      details: {
        eventId: req.params.eventId,
        guestId: req.params.guestId || req.user?.uid,
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({ error: 'Failed to fetch guest photos', details: error.message });
  }
};

// Get all events that a guest has joined
export const getGuestEvents = async (req, res) => {
  try {
    const guestId = req.user.uid; // Use authenticated user's UID

    // Get all guest records for this user
    const guestSnap = await db.collection('guests')
      .where('guestId', '==', guestId)
      .orderBy('createdAt', 'desc')
      .get();

    if (guestSnap.empty) {
      return res.json({
        success: true,
        events: [],
        message: 'No events found for this guest'
      });
    }

    // Get event IDs from guest records
    const eventIds = guestSnap.docs.map(doc => doc.data().eventId);

    // Get event details for all events
    const eventsData = [];

    for (const eventId of eventIds) {
      try {
        const eventDoc = await db.collection('events').doc(eventId).get();
        if (eventDoc.exists) {
          const event = eventDoc.data();

          // Get owner name from users collection
          let ownerName = 'Event Owner';
          try {
            const userSnap = await db.collection('users').doc(event.userId).get();
            if (userSnap.exists) {
              const userData = userSnap.data();
              ownerName = userData.displayName || userData.email || ownerName;
            }
          } catch (e) {
            console.warn('Failed to get owner name for event:', eventId);
          }

          // Get guest data for this event
          const guestData = guestSnap.docs.find(doc => doc.data().eventId === eventId)?.data();

          // Format event date
          let eventDate = '';
          if (event.eventDate && event.timeZone && event.eventDate.toDate) {
            eventDate = DateTime.fromJSDate(event.eventDate.toDate(), { zone: event.timeZone })
              .toFormat('yyyy-MM-dd HH:mm:ssZZ');
          } else if (event.eventDate && event.eventDate.toDate) {
            eventDate = event.eventDate.toDate().toISOString();
          }

          // Determine event status and expires
          let eventStatus = 'active';
          let expires = false;
          const now = new Date();
          let eventEndDate = null;

            const nowInEventTZ = DateTime.utc().minus({ hours: 4 });
                if (nowInEventTZ > event.eventEndDate?.toDate()) {
               
                  console.log('Event is expired based on current time:', nowInEventTZ.toISO());
                  console.log('Event is expired based on eventEndDate:', event.eventEndDate?.toDate());
                  eventStatus = 'expired';
                  expires = true;
                } else{
                  console.log('Event is still active based on current time:', nowInEventTZ.toISO());
                  console.log('Event is still active based on eventEndDate:', event.eventEndDate?.toDate());
                  eventStatus = 'active';
                  expires = false;
                }

          // Try to get the event end date/time
          if (event.eventDate && event.eventDate.toDate) {
            eventEndDate = event.eventDate.toDate();
          } else if (event.eventDate) {
            eventEndDate = new Date(event.eventDate);
          }

          if (eventEndDate && event.eventEndTime) {
            const [hours, minutes] = event.eventEndTime.split(':');
            eventEndDate.setHours(parseInt(hours), parseInt(minutes));
          }

          // If eventEndDate is valid, determine if expired
          // if (eventEndDate && now > eventEndDate) {
          //   eventStatus = 'expired';
          //   expires = true;
          // } else if (event.status === 'inactive') {
          //   eventStatus = 'inactive';
          //   expires = false;
          // } else {
          //   expires = false;
          // }

          // --- Calculate storageExpired ---
          // storageExpired = true if now > (eventDate + storageDays)
          let storageExpired = false;
          let storageDays = null;
          // Try to get storageDays from customPlan or plan
          if (event.customPlan && typeof event.customPlan.storageDays === "number") {
            storageDays = event.customPlan.storageDays;
          } else if (event.plan && typeof event.plan.storageDays === "number") {
            storageDays = event.plan.storageDays;
          }

          // Use eventDate in ISO string for calculation
          let eventDateISO = null;
          if (event.eventDate && event.eventDate.toDate) {
            eventDateISO = event.eventDate.toDate().toISOString();
          } else if (event.eventDate) {
            // If already ISO string or Date
            if (typeof event.eventDate === "string") {
              eventDateISO = event.eventDate;
            } else if (event.eventDate instanceof Date) {
              eventDateISO = event.eventDate.toISOString();
            }
          }

          if (eventDateISO && storageDays != null) {
            // Add storageDays to eventDateISO
            // Use luxon for time zone correctness
            let eventDateObj = DateTime.fromISO(eventDateISO, { zone: event.timeZone || 'local' });
            let storageExpiryDate = eventDateObj.plus({ days: storageDays });
            const nowInEventTZ = DateTime.now().setZone(event.timeZone || 'local');
            storageExpired = nowInEventTZ > storageExpiryDate;
          }

          // Check if user is event owner
          const isEventOwner = event.userId === guestId;
          
          eventsData.push({
            eventId: event.eventId,
            eventName: event.name,
            eventCategory: event.type || 'General',
            eventOwnerName: ownerName,
            eventStatus: eventStatus,
            expires: expires,
            storageExpired: storageExpired,
            eventDate: eventDate,
            eventStartTime: event.eventStartTime,
            eventEndTime: event.eventEndTime,
            eventPictureUrl: event.eventPictureUrl,
            shareCode: event.shareCode,
            // Guest-specific data
            guestName: guestData?.name || 'Anonymous Guest',
            photosUploaded: guestData?.photosUploaded || 0,
            photosPerGuest: event.customPlan?.photosPerGuest || event.plan?.photosPerGuest || 5,
            termsAccepted: isEventOwner ? true : (guestData?.termsAccepted || false),
            isEventOwner: isEventOwner,
            joinedAt: guestData?.createdAt?.toDate?.() || guestData?.createdAt || null
          });
        }
      } catch (error) {
        console.error('Error fetching event details for eventId:', eventId, error);
        // Continue with other events even if one fails
      }
    }

    // Sort events by event date (most recent first)
    eventsData.sort((a, b) => {
      const dateA = new Date(a.eventDate);
      const dateB = new Date(b.eventDate);
      return dateB - dateA;
    });

    res.json({
      success: true,
      events: eventsData,
      totalEvents: eventsData.length
    });

  } catch (error) {
    console.error('Get Guest Events Error:', error);

    // Audit log: Get guest events failed
    await createAuditLog({
      type: AUDIT_TYPES.ERROR,
      userId: req.user?.uid || null,
      userEmail: req.user?.email || 'anonymous@guest',
      eventId: null,
      eventName: null,
      action: 'Get guest events failed',
      details: {
        error: error.message
      },
      status: AUDIT_STATUS.ERROR,
      request: req
    });

    res.status(500).json({
      success: false,
      error: 'Failed to fetch guest events',
      details: error.message
    });
  }
};

// Like a photo
export const likePhoto = async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    const guestId = req.user.uid;

    // Check if user is authenticated
    if (!guestId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get the photo document
    const photoDoc = await db.collection('photos').doc(photoId).get();
    if (!photoDoc.exists) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const photoData = photoDoc.data();
    
    // Verify the photo belongs to the specified event
    if (photoData.eventId !== eventId) {
      return res.status(400).json({ error: 'Photo does not belong to this event' });
    }

    // Check if user has already liked the photo
    const likes = photoData.likes || [];
    if (likes.includes(guestId)) {
      return res.status(400).json({ error: 'Photo already liked by this user' });
    }

    // Add user to likes array and increment like count
    const updatedLikes = [...likes, guestId];
    const updatedLikeCount = (photoData.likeCount || 0) + 1;

    // Update the photo document
    await db.collection('photos').doc(photoId).update({
      likes: updatedLikes,
      likeCount: updatedLikeCount,
      updatedAt: new Date()
    });

    // Also update in the event's photos subcollection if it exists
    try {
      await db.collection('events').doc(eventId).collection('photos').doc(photoId).update({
        likes: updatedLikes,
        likeCount: updatedLikeCount,
        updatedAt: new Date()
      });
    } catch (error) {
      console.log('Event photos subcollection update failed, continuing...');
    }

    res.json({ 
      success: true, 
      message: 'Photo liked successfully',
      likeCount: updatedLikeCount,
      isLiked: true
    });

  } catch (error) {
    console.error('Like Photo Error:', error);
    res.status(500).json({ error: 'Failed to like photo' });
  }
};

// Unlike a photo
export const unlikePhoto = async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    const guestId = req.user.uid;

    // Check if user is authenticated
    if (!guestId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get the photo document
    const photoDoc = await db.collection('photos').doc(photoId).get();
    if (!photoDoc.exists) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const photoData = photoDoc.data();
    
    // Verify the photo belongs to the specified event
    if (photoData.eventId !== eventId) {
      return res.status(400).json({ error: 'Photo does not belong to this event' });
    }

    // Check if user has liked the photo
    const likes = photoData.likes || [];
    if (!likes.includes(guestId)) {
      return res.status(400).json({ error: 'Photo not liked by this user' });
    }

    // Remove user from likes array and decrement like count
    const updatedLikes = likes.filter(id => id !== guestId);
    const updatedLikeCount = Math.max(0, (photoData.likeCount || 0) - 1);

    // Update the photo document
    await db.collection('photos').doc(photoId).update({
      likes: updatedLikes,
      likeCount: updatedLikeCount,
      updatedAt: new Date()
    });

    // Also update in the event's photos subcollection if it exists
    try {
      await db.collection('events').doc(eventId).collection('photos').doc(photoId).update({
        likes: updatedLikes,
        likeCount: updatedLikeCount,
        updatedAt: new Date()
      });
    } catch (error) {
      console.log('Event photos subcollection update failed, continuing...');
    }

    res.json({ 
      success: true, 
      message: 'Photo unliked successfully',
      likeCount: updatedLikeCount,
      isLiked: false
    });

  } catch (error) {
    console.error('Unlike Photo Error:', error);
    res.status(500).json({ error: 'Failed to unlike photo' });
  }
};

// Toggle like status (like if not liked, unlike if already liked)
export const togglePhotoLike = async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    const guestId = req.user.uid;

    // Check if user is authenticated
    if (!guestId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get the photo document
    const photoDoc = await db.collection('photos').doc(photoId).get();
    if (!photoDoc.exists) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const photoData = photoDoc.data();
    
    // Verify the photo belongs to the specified event
    if (photoData.eventId !== eventId) {
      return res.status(400).json({ error: 'Photo does not belong to this event' });
    }

    const likes = photoData.likes || [];
    const isCurrentlyLiked = likes.includes(guestId);

    let updatedLikes, updatedLikeCount, isLiked;

    if (isCurrentlyLiked) {
      // Unlike the photo
      updatedLikes = likes.filter(id => id !== guestId);
      updatedLikeCount = Math.max(0, (photoData.likeCount || 0) - 1);
      isLiked = false;
    } else {
      // Like the photo
      updatedLikes = [...likes, guestId];
      updatedLikeCount = (photoData.likeCount || 0) + 1;
      isLiked = true;
    }

    // Update the photo document
    await db.collection('photos').doc(photoId).update({
      likes: updatedLikes,
      likeCount: updatedLikeCount,
      updatedAt: new Date()
    });

    // Also update in the event's photos subcollection if it exists
    try {
      await db.collection('events').doc(eventId).collection('photos').doc(photoId).update({
        likes: updatedLikes,
        likeCount: updatedLikeCount,
        updatedAt: new Date()
      });
    } catch (error) {
      console.log('Event photos subcollection update failed, continuing...');
    }

    res.json({ 
      success: true, 
      message: isLiked ? 'Photo liked successfully' : 'Photo unliked successfully',
      likeCount: updatedLikeCount,
      isLiked: isLiked
    });

  } catch (error) {
    console.error('Toggle Photo Like Error:', error);
    res.status(500).json({ error: 'Failed to toggle photo like' });
  }
};




