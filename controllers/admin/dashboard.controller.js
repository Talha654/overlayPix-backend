import { db } from "../../services/firebase.service.js";
import { notFoundResponse, serverErrorResponse, successResponse } from "../../utils/responses.js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2 } from "../../services/r2.service.js";

import dotenv from 'dotenv';
dotenv.config();

export const getAllActiveEvents = async (req, res) => {
    try {
      const limit = 10; // Fixed limit
      const cursor = req.query.cursor; // Base64 encoded cursor
      const direction = req.query.direction || "next"; // 'next' or 'prev'
  
      let baseQuery = db.collection("events")
        .where("status", "==", "active")
        .orderBy("eventDate", "asc")
        .orderBy("__name__", "asc"); // Secondary sort for tie-breaking
  
      const pageLimitPlusOne = limit + 1;
      let queryToRun = baseQuery;
  
      // Resolve cursor to DocumentSnapshot
      let cursorDocSnap = null;
      if (cursor) {
        try {
          const decodedCursor = JSON.parse(Buffer.from(cursor, "base64").toString());
          const { docId } = decodedCursor;
          cursorDocSnap = await db.collection("events").doc(docId).get();
          if (!cursorDocSnap.exists) {
            return serverErrorResponse(res, "Invalid cursor: document not found");
          }
        } catch (error) {
          console.error("Invalid cursor format:", error);
          return serverErrorResponse(res, "Invalid cursor format");
        }
      }
  
      // Pagination logic
      if (cursor && direction === "prev") {
        queryToRun = queryToRun.endBefore(cursorDocSnap).limitToLast(pageLimitPlusOne);
      } else if (cursor) {
        queryToRun = queryToRun.startAfter(cursorDocSnap).limit(pageLimitPlusOne);
      } else {
        queryToRun = queryToRun.limit(pageLimitPlusOne);
      }
  
      const snapshot = await queryToRun.get();
      if (snapshot.empty) {
        return notFoundResponse(res, "No active events found.");
      }
  
      let docs = snapshot.docs.slice();
      const fetchedMore = docs.length > limit;
  
      // Trim the extra doc
      if (fetchedMore) {
        if (direction === "prev") {
          docs = docs.slice(1);
        } else {
          docs = docs.slice(0, limit);
        }
      }
  
      // Parse events
      const events = docs.map(doc => {
        const data = doc.data();
        let eventDate = null;
  
        if (data.eventDate) {
          if (typeof data.eventDate.toDate === "function") {
            eventDate = data.eventDate.toDate().toISOString();
          } else if (data.eventDate instanceof Date) {
            eventDate = data.eventDate.toISOString();
          } else if (typeof data.eventDate === "string" || typeof data.eventDate === "number") {
            const d = new Date(data.eventDate);
            eventDate = isNaN(d.getTime()) ? null : d.toISOString();
          }
        } else if (data.date) {
          if (typeof data.date.toDate === "function") {
            eventDate = data.date.toDate().toISOString();
          } else if (data.date instanceof Date) {
            eventDate = data.date.toISOString();
          } else if (typeof data.date === "string" || typeof data.date === "number") {
            const d = new Date(data.date);
            eventDate = isNaN(d.getTime()) ? null : d.toISOString();
          }
        }
  
        return {
          id: doc.id,
          ...data,
          eventDate,
        };
      });
  
      // Collect event/user IDs
      const eventIds = events.map(e => e.id);
      const userIds = [...new Set(events.map(e => e.userId).filter(Boolean))];
  
      const chunkArray = (array, size) => {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
          chunks.push(array.slice(i, i + size));
        }
        return chunks;
      };
      const eventIdChunks = chunkArray(eventIds, 30);
  
      // Fetch related data in parallel
      const [allGuestsSnapshots, allPhotosSnapshots, userDocs] = await Promise.all([
        Promise.all(eventIdChunks.map(chunk =>
          db.collection("guests").where("eventId", "in", chunk).get()
        )),
        Promise.all(eventIdChunks.map(chunk =>
          db.collection("photos").where("eventId", "in", chunk).get()
        )),
        userIds.length > 0 ? Promise.all(
          userIds.map(userId => db.collection("users").doc(userId).get())
        ) : Promise.resolve([])
      ]);
  
      // Build maps
      const guestCountMap = {};
      allGuestsSnapshots.forEach(snap =>
        snap.docs.forEach(doc => {
          const eventId = doc.data().eventId;
          guestCountMap[eventId] = (guestCountMap[eventId] || 0) + 1;
        })
      );
  
      const photoCountMap = {};
      allPhotosSnapshots.forEach(snap =>
        snap.docs.forEach(doc => {
          const eventId = doc.data().eventId;
          photoCountMap[eventId] = (photoCountMap[eventId] || 0) + 1;
        })
      );
  
      const userMap = {};
      userDocs.forEach(doc => {
        if (doc.exists) {
          userMap[doc.id] = doc.data().fullName || null;
        }
      });
  
      // Build final response
      const final = events.map(event => ({
        name: event.name || "Unnamed Event",
        eventDate: event.eventDate || null,
        eventStartTime: event.eventStartTime || null,
        eventEndTime: event.eventEndTime || null,
        clientName: userMap[event.userId] || null,
        guestCount: guestCountMap[event.id] || 0,
        photoCount: photoCountMap[event.id] || 0,
        status: event.status || "unknown",
      }));
  
      // Cursors
      const firstDoc = docs[0];
      const lastDoc = docs[docs.length - 1];
      const makeCursor = (doc) => Buffer.from(JSON.stringify({
        eventDate: doc.data().eventDate?.toDate?.()?.toISOString() || doc.data().eventDate,
        docId: doc.id
      })).toString("base64");
  
      const firstCursor = firstDoc ? makeCursor(firstDoc) : null;
      const lastCursor = lastDoc ? makeCursor(lastDoc) : null;
  
      // hasNext/hasPrev
      let hasNextPage = false;
      let hasPrevPage = false;
      if (direction === "prev") {
        hasPrevPage = fetchedMore;
        hasNextPage = !!cursor;
      } else {
        hasNextPage = fetchedMore;
        hasPrevPage = !!cursor;
      }
  
      return successResponse(res, "Active events retrieved successfully.", {
        events: final,
        pagination: {
          limit,
          hasNextPage,
          hasPrevPage,
          nextCursor: hasNextPage ? lastCursor : null,
          prevCursor: hasPrevPage ? firstCursor : null,
          totalEvents: final.length
        }
      });
    } catch (error) {
      console.error("Error fetching active events:", error);
      return serverErrorResponse(res, error.message);
    }
  };
  

export const getR2Stats = async (req, res) => {
    // Always fetch these first so they're available in all code paths
    let activeEventsCount = 0;
    let totalUsersCount = 0;
    try {
        // Fetch database statistics in parallel
        const [activeEventsSnapshot, usersSnapshot] = await Promise.all([
            db.collection("events").where("status", "==", "active").count().get(),
            db.collection("users").count().get()
        ]);

        // Firestore aggregate query returns .data().count, not .count directly
        activeEventsCount = activeEventsSnapshot.data().count || 0;
        totalUsersCount = usersSnapshot.data().count || 0;

        console.log(activeEventsCount, totalUsersCount);

        // OPTIMIZED: Use the simpler and working R2 usage API
        if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.R2_BUCKET) {
            try {
                console.log('[R2 STATS] Fetching usage with R2 API...');
                
                // Use the working R2 usage endpoint
                const response = await fetch(
                    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${process.env.R2_BUCKET}/usage`,
                    {
                        method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    }
                );

                if (!response.ok) {
                    throw new Error(`R2 API failed: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                
                if (data.success && data.result) {
                    const result = data.result;
                    
                    // Convert payload size from bytes to MB & GB
                    const payloadSizeBytes = parseInt(result.payloadSize || 0);
                    const totalSizeMB = (payloadSizeBytes / (1024 * 1024)).toFixed(2);
                    const totalSizeGB = (payloadSizeBytes / (1024 * 1024 * 1024)).toFixed(2);
                    
                    // Get object count (total photos)
                    const totalPhotos = parseInt(result.objectCount || 0);

                const stats = {
                        totalPhotos,
                    totalSizeMB,
                    totalSizeGB,
                    activeEventsCount,
                    totalUsersCount,
                        // Additional R2 metrics
                        // metadataSize: result.metadataSize,
                        // uploadCount: result.uploadCount,
                        // infrequentAccessPayloadSize: result.infrequentAccessPayloadSize,
                        // infrequentAccessObjectCount: result.infrequentAccessObjectCount
                };

                    console.log(`[R2 STATS] Retrieved: ${totalPhotos} photos, ${totalSizeMB} MB, ${activeEventsCount} active events, ${totalUsersCount} users`);

                return successResponse(res, "Dashboard statistics retrieved successfully.", stats);
                } else {
                    throw new Error('R2 API returned unsuccessful response');
                }

            } catch (r2Error) {
                console.error("R2 API approach failed, using fallback:", r2Error);
            }
        }

        // Fallback: Return database stats only
        console.log('[R2 STATS] Using database-only fallback...');

        const stats = {
            totalPhotos: 0,
            totalSizeMB: "0.00",
            totalSizeGB: "0.00",
            activeEventsCount,
            totalUsersCount,
            // metadataSize: "0",
            // uploadCount: "0",
            // infrequentAccessPayloadSize: "0",
            // infrequentAccessObjectCount: "0"
        };

        return successResponse(res, "Dashboard statistics retrieved successfully.", stats);

    } catch (error) {
        console.error("Error fetching dashboard stats:", error);

        // Final fallback: Return empty stats
        const stats = {
            totalPhotos: 0,
            totalSizeMB: "0.00",
            totalSizeGB: "0.00",
            activeEventsCount,
            totalUsersCount,
            // metadataSize: "0",
            // uploadCount: "0",
            // infrequentAccessPayloadSize: "0",
            // infrequentAccessObjectCount: "0"
        };
        
        return successResponse(res, "Dashboard statistics retrieved successfully.", stats);
    }
};

// OPTIMIZED: Get just the counts for active events (for dashboard stats)
export const getActiveEventsStats = async (req, res) => {
    try {
        // Get total count of active events
        const activeEventsSnapshot = await db
            .collection("events")
            .where("status", "==", "active")
            .get();

        const totalActiveEvents = activeEventsSnapshot.size;

        // Get total counts for guests and photos across all active events
        const eventIds = activeEventsSnapshot.docs.map(doc => doc.id);
        
        if (eventIds.length === 0) {
            return successResponse(res, "Stats retrieved successfully.", {
                totalActiveEvents: 0,
                totalGuests: 0,
                totalPhotos: 0
            });
        }

        // Helper function to chunk arrays
        const chunkArray = (array, chunkSize) => {
            const chunks = [];
            for (let i = 0; i < array.length; i += chunkSize) {
                chunks.push(array.slice(i, i + chunkSize));
            }
            return chunks;
        };

        const eventIdChunks = chunkArray(eventIds, 30);

        // Get total counts in parallel
        const [allGuestsSnapshots, allPhotosSnapshots] = await Promise.all([
            Promise.all(
                eventIdChunks.map(chunk =>
                    db.collection("guests").where("eventId", "in", chunk).get()
                )
            ),
            Promise.all(
                eventIdChunks.map(chunk =>
                    db.collection("photos").where("eventId", "in", chunk).get()
                )
            )
        ]);

        // Count totals
        const totalGuests = allGuestsSnapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);
        const totalPhotos = allPhotosSnapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);

        return successResponse(res, "Stats retrieved successfully.", {
            totalActiveEvents,
            totalGuests,
            totalPhotos
        });

    } catch (error) {
        console.error("Error fetching active events stats:", error);
        return serverErrorResponse(res, error.message);
    }
};




