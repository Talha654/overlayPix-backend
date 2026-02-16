import { db } from "../../services/firebase.service.js";
import { 
    successResponse, 
    notFoundResponse, 
    serverErrorResponse 
} from "../../utils/responses.js";
// import { auditEventToggle, auditAdminAction, AUDIT_STATUS } from "../../services/audit.service.js";

export const getAllEvents = async (req, res) => {
    try {
      // Pagination params
      const limit = parseInt(req.query.limit) || 10;
      const cursor = req.query.cursor; // Base64 encoded cursor
      const direction = req.query.direction || "next"; // 'next' or 'prev'
  
      const eventsRef = db.collection("events");
      let baseQuery = eventsRef.orderBy("__name__", "asc"); // Order by document ID
      const pageLimitPlusOne = limit + 1;
  
      // Resolve cursor to DocumentSnapshot if provided
      let cursorDocSnap = null;
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
          const { docId } = decoded;
          if (!docId) throw new Error("cursor missing docId");
  
          cursorDocSnap = await eventsRef.doc(docId).get();
          if (!cursorDocSnap.exists) {
            return serverErrorResponse(res, "Cursor document not found.");
          }
        } catch (err) {
          console.error("Invalid cursor format or fetch error:", err);
          return serverErrorResponse(res, "Invalid cursor format");
        }
      }
  
      // Build query depending on pagination direction
      let queryToRun;
      if (cursor && direction === "prev") {
        // previous page: get items before cursor, fetch one extra to detect more pages
        queryToRun = baseQuery.endBefore(cursorDocSnap).limitToLast(pageLimitPlusOne);
      } else if (cursor) {
        // next page: get items after cursor, fetch one extra
        queryToRun = baseQuery.startAfter(cursorDocSnap).limit(pageLimitPlusOne);
      } else {
        // first page
        queryToRun = baseQuery.limit(pageLimitPlusOne);
      }
  
      const snapshot = await queryToRun.get();
  
      if (snapshot.empty) {
        return notFoundResponse(res, "No events found.");
      }
  
      // Convert to array and check if we fetched an extra item
      let docs = snapshot.docs.slice();
      const fetchedMore = docs.length > limit;
  
      // Trim the extra doc depending on direction
      if (fetchedMore) {
        if (direction === "prev") {
          // limitToLast(pageLimitPlusOne) returns extra doc at start
          docs = docs.slice(1);
        } else {
          // limit(pageLimitPlusOne) returns extra doc at end
          docs = docs.slice(0, limit);
        }
      }
  
      // Parse events from the visible docs (trimmed)
      const events = docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  
      // If no events after trimming (edge case), return empty
      if (events.length === 0) {
        return successResponse(res, "All events retrieved successfully.", {
          events: [],
          pagination: {
            limit,
            hasNextPage: false,
            hasPrevPage: !!cursor,
            nextCursor: null,
            prevCursor: null,
            totalEvents: 0
          }
        });
      }
  
      // Collect IDs for related lookups
      const eventIds = events.map((e) => e.id);
      const userIds = [...new Set(events.map((e) => e.userId).filter(Boolean))];
  
      // Helper: chunking to respect Firestore 'in' limit (30)
      const chunkArray = (array, chunkSize) => {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
          chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
      };
      const eventIdChunks = chunkArray(eventIds, 30);
  
      // Fetch related data in parallel
      const [allGuestsSnapshots, allPhotosSnapshots, userDocs] = await Promise.all([
        Promise.all(
          eventIdChunks.map((chunk) =>
            db.collection("guests").where("eventId", "in", chunk).get()
          )
        ),
        Promise.all(
          eventIdChunks.map((chunk) =>
            db.collection("photos").where("eventId", "in", chunk).get()
          )
        ),
        userIds.length > 0
          ? Promise.all(userIds.map((uid) => db.collection("users").doc(uid).get()))
          : Promise.resolve([])
      ]);
  
      // Build guestCountMap
      const guestCountMap = {};
      allGuestsSnapshots.forEach((snap) =>
        snap.docs.forEach((d) => {
          const eventId = d.data().eventId;
          guestCountMap[eventId] = (guestCountMap[eventId] || 0) + 1;
        })
      );
  
      // Build photoCountMap
      const photoCountMap = {};
      allPhotosSnapshots.forEach((snap) =>
        snap.docs.forEach((d) => {
          const eventId = d.data().eventId;
          photoCountMap[eventId] = (photoCountMap[eventId] || 0) + 1;
        })
      );
  
      // Build userMap
      const userMap = {};
      userDocs.forEach((d) => {
        if (d.exists) userMap[d.id] = d.data().fullName || null;
      });
  
      // Final payload
      const final = events.map((event) => ({
        id: event.id,
        name: event.name || "Unnamed Event",
        clientName: userMap[event.userId] || null,
        guestCount: guestCountMap[event.id] || 0,
        photoCount: photoCountMap[event.id] || 0,
        status: event.status || "unknown",
        state: event.status === "active"
      }));
  
      // Create cursors from the visible docs
      const firstDoc = docs[0];
      const lastDoc = docs[docs.length - 1];
  
      const makeCursor = (doc) =>
        Buffer.from(JSON.stringify({ docId: doc.id })).toString("base64");
  
      const firstCursor = firstDoc ? makeCursor(firstDoc) : null;
      const lastCursor = lastDoc ? makeCursor(lastDoc) : null;
  
      // Compute hasNext/hasPrev
      let hasNextPage = false;
      let hasPrevPage = false;
      if (direction === "prev") {
        hasPrevPage = fetchedMore;      // if we fetched more, there's still earlier pages
        hasNextPage = !!cursor;         // we came from a newer page, so the "next" (the page we came from) exists
      } else {
        hasNextPage = fetchedMore;      // fetched extra => more pages after
        hasPrevPage = !!cursor;         // cursor existence implies a previous page exists
      }
  
      const response = {
        events: final,
        pagination: {
          limit,
          hasNextPage,
          hasPrevPage,
          nextCursor: hasNextPage ? lastCursor : null,
          prevCursor: hasPrevPage ? firstCursor : null,
          totalEvents: final.length
        }
      };
  
      return successResponse(res, "All events retrieved successfully.", response);
    } catch (error) {
      console.error("Error fetching all events:", error);
      return serverErrorResponse(res, error.message);
    }
  };
  


export const toggleEventState = async (req, res) => {
    try {
        const { eventId } = req.params;
        const { state } = req.body; // true or false

        console.log(`[EVENT MANAGEMENT] Toggling event state: ${eventId}, state: ${state}`);

        // Validate eventId
        if (!eventId) {
            return res.status(400).json({ error: 'Event ID is required' });
        }

        // Validate state
        if (typeof state !== 'boolean') {
            return res.status(400).json({ error: 'State must be a boolean (true or false)' });
        }

        // Get the event
        const eventDoc = await db.collection('events').doc(eventId).get();
        if (!eventDoc.exists) {
            return notFoundResponse(res, "Event not found");
        }

        const eventData = eventDoc.data();
        const currentStatus = eventData.status || 'unknown';

        // Determine new status based on state
        const newStatus = state === true ? 'active' : 'ended';

        // Update the event status
        await db.collection('events').doc(eventId).update({
            status: newStatus,
            updatedAt: new Date(),
            updatedBy: 'admin'
        });

        console.log(`[EVENT MANAGEMENT] Event state updated: ${eventId}, ${currentStatus} -> ${newStatus}`);

        // Audit log: Event toggle
        // await auditEventToggle(
        //     req.user?.uid || 'admin',
        //     req.user?.email || 'admin@system',
        //     eventId,
        //     eventData.name,
        //     newStatus,
        //     AUDIT_STATUS.SUCCESS,
        //     req
        // );

        // Return the updated event data
        const updatedEventDoc = await db.collection('events').doc(eventId).get();
        const updatedEvent = updatedEventDoc.data();

        return successResponse(res, `Event state updated successfully. Status: ${newStatus}`, {
            eventId,
            previousStatus: currentStatus,
            newStatus: newStatus,
            state: state,
            event: {
                id: eventId,
                name: updatedEvent.name || "Unnamed Event",
                status: updatedEvent.status,
                state: newStatus === 'active' ? true : false,
                updatedAt: updatedEvent.updatedAt
            }
        });

    } catch (error) {
        console.error("Error toggling event state:", error);
        return serverErrorResponse(res, error.message);
    }
};