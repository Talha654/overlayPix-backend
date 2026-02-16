import { db } from '../../services/firebase.service.js';
import { r2 } from '../../services/r2.service.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { 
    successResponse, 
    notFoundResponse, 
    serverErrorResponse,
    badRequestResponse
} from '../../utils/responses.js';

// Helper function to construct R2 public URL
function getR2PublicUrl(key) {
  const endpoint = `${process.env.R2_PUBLIC_DOMAIN}/${process.env.R2_BUCKET}/${key}`;
  return endpoint;
}

// CREATE
export const createAdminOverlay = async (req, res) => {
  try {
    let { name, category } = req.body;
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Overlay file is required.' });
    }

    // Handle category: if it's a stringified array, parse it
    if (typeof category === 'string') {
      console.log('category is a string', category);
      try {
        // Try to parse as JSON array
        const parsed = JSON.parse(category);
        console.log('parsed', parsed);
        if (Array.isArray(parsed)) {
          category = parsed;
          console.log('category is an array', category);
        } else {
          // If not an array, wrap as array
          category = [category];
          console.log('else category is an array', category);
        }
      } catch (e) {
        // If not JSON, treat as comma-separated string
        if (category.includes(',')) {
          category = category.split(',').map(c => c.trim());
          console.log('cacth category is a comma-separated string', category);
        } else {
          category = [category];
          console.log('catch else category is an array', category);
        }
      }
    } else if (!Array.isArray(category)) {
      category = [category];
    }

    const overlayRef = db.collection('adminOverlays').doc();
    const overlayId = overlayRef.id;
    const overlayFile = req.file;
    const overlayFileName = `adminOverlays/${overlayId}/overlay-${Date.now()}.png`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: overlayFileName,
      Body: overlayFile.buffer,
      ContentType: overlayFile.mimetype,
    }));
    const url = getR2PublicUrl(overlayFileName);
    const overlayData = {
      name,
      category,
      url,
      fileName: overlayFileName, // Store the file path for future reference
      status: 'active', // Default status for new overlays
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await overlayRef.set(overlayData);
    res.status(201).json({ id: overlayId, ...overlayData });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create overlay', details: error.message });
  }
};

// READ ALL
export const getAdminOverlays = async (req, res) => {
  try {
    // Get user role from request (set by auth middleware)
    const userRole = req.user?.role || 'user';
    const isAdmin = userRole === 'admin';

    console.log(`[OVERLAY MANAGEMENT] Fetching overlays for user role: ${userRole}, isAdmin: ${isAdmin}`);

    let overlays = [];

    if (isAdmin) {
      // Admin: Fetch all overlays regardless of status
      console.log('[OVERLAY MANAGEMENT] Admin access - fetching all overlays');
      const snapshot = await db.collection('adminOverlays').get();
      overlays = snapshot.docs.map(doc => {
        const data = doc.data();
        // Add state: true if status is 'active', false if 'inactive' (or any other value)
        return { 
          id: doc.id, 
          ...data, 
          state: data.status === 'active' ? true : false 
        };
      });
    
    } else {
      // Non-admin: Fetch only active overlays
      console.log('[OVERLAY MANAGEMENT] Non-admin access - fetching only active overlays');
      const snapshot = await db.collection('adminOverlays')
        .where('status', '==', 'active')
        .get();
      overlays = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    // OPTIMIZED: Get overlay usage count more efficiently
    // Only fetch events that have overlayId field to count usage
    const eventsSnapshot = await db.collection('events')
      .where('overlayId', '!=', null)
      .get();
    
    const overlayUsageMap = {};
    const currentlyActiveOverlays = new Set(); // Track currently active overlay IDs
    const currentDate = new Date();

    eventsSnapshot.docs.forEach(eventDoc => {
      const eventData = eventDoc.data();
      const overlayId = eventData.overlayId;
      if (overlayId) {
        overlayUsageMap[overlayId] = (overlayUsageMap[overlayId] || 0) + 1;

      // Check if this event is currently active based on date and time
const eventDate = eventData.eventDate;
const eventStartTime = eventData.eventStartTime;
const eventEndTime = eventData.eventEndTime;

if (eventDate && eventStartTime && eventEndTime) {
  try {
    // Parse event date - handle both Firestore Timestamp and string formats
    let eventDateObj;
    
    if (eventDate && typeof eventDate === 'object' && eventDate._seconds) {
      // Handle Firestore Timestamp object
      eventDateObj = new Date(eventDate._seconds * 1000);
    } else if (typeof eventDate === 'string') {
      // Handle string date
      eventDateObj = new Date(eventDate);
    } else if (eventDate instanceof Date) {
      // Handle Date object
      eventDateObj = eventDate;
    } else {
      console.warn(`[OVERLAY MANAGEMENT] Unknown date format for event ${eventDoc.id}:`, eventDate);
      return; // Skip this event
    }
    
    // Validate the parsed date
    if (isNaN(eventDateObj.getTime())) {
      console.warn(`[OVERLAY MANAGEMENT] Invalid date for event ${eventDoc.id}:`, eventDate);
      return; // Skip this event
    }
    
    const [startHour, startMinute] = eventStartTime.split(':').map(Number);
    const [endHour, endMinute] = eventEndTime.split(':').map(Number);
    
    console.log('eventData.id', eventDoc.id);
    console.log('eventData.eventDate', eventData.eventDate);
    console.log('eventDateObj', eventDateObj);
    
    // Create start and end datetime objects
    const eventStartDateTime = new Date(eventDateObj);
    eventStartDateTime.setHours(startHour, startMinute, 0, 0);
    console.log('eventStartDateTime', eventStartDateTime);
    
    const eventEndDateTime = new Date(eventDateObj);
    eventEndDateTime.setHours(endHour, endMinute, 0, 0);
    console.log('eventEndDateTime', eventEndDateTime);
    
    // Handle overnight events (end time before start time)
    if (eventEndDateTime < eventStartDateTime) {
      eventEndDateTime.setDate(eventEndDateTime.getDate() + 1);
    }
    
    // Check if current time falls within the event duration
    if (currentDate >= eventStartDateTime && currentDate <= eventEndDateTime) {
      currentlyActiveOverlays.add(overlayId);
      console.log(`[OVERLAY MANAGEMENT] Currently active overlay: ${overlayId} for event: ${eventData.name}`);
    }
  } catch (timeError) {
    console.warn(`[OVERLAY MANAGEMENT] Error parsing event time for event ${eventData.eventId}:`, timeError);
  }
}
      }
    });

    // Attach usedCount to each overlay (keeping exact same structure)
    const overlaysWithUsedCount = overlays.map(overlay => ({
      ...overlay,
      usedCount: overlayUsageMap[overlay.id] || 0,
      isCurrentlyUsing: Array.from(currentlyActiveOverlays).filter(id => id === overlay.id).length
    }));

    console.log(`[OVERLAY MANAGEMENT] Returning ${overlaysWithUsedCount.length} overlays for ${userRole} user`);
    console.log(`[OVERLAY MANAGEMENT] Currently active overlays: ${Array.from(currentlyActiveOverlays).join(', ')}`);

    res.json(overlaysWithUsedCount);
  } catch (error) {
    console.error('[OVERLAY MANAGEMENT] Error fetching overlays:', error);
    res.status(500).json({ error: 'Failed to fetch overlays' });
  }
};

// READ ONE
export const getAdminOverlayById = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('adminOverlays').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Overlay not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch overlay' });
  }
};

// GET BY CATEGORY
export const getAdminOverlaysByCategory = async (req, res) => {
    try {
      const { category } = req.params;
      if (!category) {
        return res.status(400).json({ error: 'Category is required' });
      }
  
      const snapshot = await db.collection('adminOverlays')
        .where('category', '==', category)
        .get();
  
      const overlays = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(overlays);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch overlays by category', details: error.message });
    }
  };
  

// UPDATE
export const updateAdminOverlay = async (req, res) => {
  try {
    const { id } = req.params;
    let { name, category } = req.body;

     // Handle category: if it's a stringified array, parse it
     if (typeof category === 'string') {
      console.log('category is a string', category);
      try {
        // Try to parse as JSON array
        const parsed = JSON.parse(category);
        console.log('parsed', parsed);
        if (Array.isArray(parsed)) {
          category = parsed;
          console.log('category is an array', category);
        } else {
          // If not an array, wrap as array
          category = [category];
          console.log('else category is an array', category);
        }
      } catch (e) {
        // If not JSON, treat as comma-separated string
        if (category.includes(',')) {
          category = category.split(',').map(c => c.trim());
          console.log('cacth category is a comma-separated string', category);
        } else {
          category = [category];
          console.log('catch else category is an array', category);
        }
      }
    } else if (!Array.isArray(category)) {
      category = [category];
    }
    const docRef = db.collection('adminOverlays').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Overlay not found' });
    let updateData = { updatedAt: new Date() };
    if (name) updateData.name = name;
    if (category) updateData.category = category;
    if (req.file) {
      const overlayFile = req.file;
      const overlayFileName = `adminOverlays/${id}/overlay-${Date.now()}.png`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: overlayFileName,
        Body: overlayFile.buffer,
        ContentType: overlayFile.mimetype,
      }));
      updateData.url = getR2PublicUrl(overlayFileName);
      updateData.fileName = overlayFileName; // Store the file path for future reference
    }
    await docRef.update(updateData);
    const updatedDoc = await docRef.get();
    res.json({ id, ...updatedDoc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update overlay', details: error.message });
  }
};

// DELETE
export const deleteAdminOverlay = async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('adminOverlays').doc(id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete overlay' });
  }
};

// TOGGLE OVERLAY STATUS
export const toggleOverlayStatus = async (req, res) => {
    try {
        const { overlayId } = req.params;
        const { status } = req.body; // true for active, false for inactive

        console.log(`[OVERLAY MANAGEMENT] Toggling overlay status: ${overlayId}, status: ${status}`);

        // Validate overlayId
        if (!overlayId) {
            return badRequestResponse(res, "Overlay ID is required");
        }

        // Validate status
        if (typeof status !== 'boolean') {
            return badRequestResponse(res, "Status must be a boolean (true or false)");
        }

        // Get the overlay
        const overlayDoc = await db.collection('adminOverlays').doc(overlayId).get();
        if (!overlayDoc.exists) {
            return notFoundResponse(res, "Overlay not found");
        }

        const overlayData = overlayDoc.data();
        const currentStatus = overlayData.status || 'inactive';

        // Determine new status based on status parameter
        const newStatus = status === true ? 'active' : 'inactive';

        // Update the overlay status
        await db.collection('adminOverlays').doc(overlayId).update({
            status: newStatus,
            updatedAt: new Date()
        });

        console.log(`[OVERLAY MANAGEMENT] Overlay status updated: ${overlayId}, ${currentStatus} -> ${newStatus}`);

        // Return the updated overlay data
        const updatedOverlayDoc = await db.collection('adminOverlays').doc(overlayId).get();
        const updatedOverlay = updatedOverlayDoc.data();

        return successResponse(res, `Overlay status updated successfully. Status: ${newStatus}`, {
            overlayId,
            previousStatus: currentStatus,
            newStatus: newStatus,
            status: status,
            overlay: {
                id: overlayId,
                name: updatedOverlay.name || "Unnamed Overlay",
                category: updatedOverlay.category,
                status: updatedOverlay.status,
                url: updatedOverlay.url,
                updatedAt: updatedOverlay.updatedAt
            }
        });

    } catch (error) {
        console.error("Error toggling overlay status:", error);
        return serverErrorResponse(res, error.message);
    }
};
