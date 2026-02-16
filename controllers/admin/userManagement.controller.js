import { admin, db } from "../../services/firebase.service.js";
import { 
    successResponse, 
    notFoundResponse, 
    serverErrorResponse,
    badRequestResponse
} from "../../utils/responses.js";

export const getAllUsers = async (req, res) => {
    try {
      console.log("[USER MANAGEMENT] Fetching users with pagination (ordered by createdAt desc)...");
      // Query params
      const limit = parseInt(req.query.limit) || 10;
      const cursor = req.query.cursor; // base64 encoded
      const direction = req.query.direction || "next"; // 'next' | 'prev'
  
      const usersRef = db.collection("users");
  
      // Use createdAt DESC, then docId ASC as tie-breaker
      const baseQuery = usersRef.orderBy("createdAt", "desc").orderBy("__name__", "asc");
      const pageLimitPlusOne = limit + 1;
  
      // Decode cursor (docId) if provided and fetch its DocumentSnapshot
      let cursorDocSnap = null;
      if (cursor) {
        try {
          console.log("[USER MANAGEMENT] Raw cursor:", cursor);
          const cursorData = JSON.parse(Buffer.from(cursor, "base64").toString());
          console.log("[USER MANAGEMENT] Decoded cursor:", cursorData);
  
          if (!cursorData.docId) {
            console.error("[USER MANAGEMENT] Missing docId in cursor:", cursorData);
            return serverErrorResponse(res, "Invalid cursor format - missing docId");
          }
  
          const docId = cursorData.docId;
          cursorDocSnap = await usersRef.doc(docId).get();
          if (!cursorDocSnap.exists) {
            console.error("[USER MANAGEMENT] Cursor document not found:", docId);
            return serverErrorResponse(res, "Invalid cursor: document not found");
          }
          console.log("[USER MANAGEMENT] Using cursor docId:", docId);
        } catch (err) {
          console.error("[USER MANAGEMENT] Cursor decode/fetch error:", err);
          return serverErrorResponse(res, "Invalid cursor format");
        }
      }
  
      // Build query depending on direction & cursor
      let queryToRun;
      if (cursorDocSnap && direction === "prev") {
        // Previous page: get documents before the cursor, fetch one extra
        queryToRun = baseQuery.endBefore(cursorDocSnap).limitToLast(pageLimitPlusOne);
        console.log("[USER MANAGEMENT] Query: prev with limitToLast", pageLimitPlusOne);
      } else if (cursorDocSnap) {
        // Next page: get documents after the cursor, fetch one extra
        queryToRun = baseQuery.startAfter(cursorDocSnap).limit(pageLimitPlusOne);
        console.log("[USER MANAGEMENT] Query: next with startAfter", pageLimitPlusOne);
      } else {
        // First page
        queryToRun = baseQuery.limit(pageLimitPlusOne);
        console.log("[USER MANAGEMENT] Query: first page with limit", pageLimitPlusOne);
      }
  
      // Execute
      const snapshot = await queryToRun.get();
      console.log("[USER MANAGEMENT] Query executed. docs:", snapshot.docs.length);
  
      if (snapshot.empty) {
        console.log("[USER MANAGEMENT] No users found for this query/cursor.");
        return notFoundResponse(res, "No users found.");
      }
  
      // Convert to array and check if we fetched an extra item
      let docs = snapshot.docs.slice();
      const fetchedMore = docs.length > limit;
  
      // Trim the extra doc (if any)
      if (fetchedMore) {
        if (direction === "prev") {
          // limitToLast(pageLimitPlusOne) returns extra doc at start
          docs = docs.slice(1);
        } else {
          // limit(pageLimitPlusOne) returns extra doc at end
          docs = docs.slice(0, limit);
        }
      }
  
      // Map users
      const users = docs.map((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt;
        let joinedDate = createdAt;
        // if (createdAt) {
        //   const d = typeof createdAt.toDate === "function" ? createdAt.toDate() : new Date(createdAt);
        //   if (!isNaN(d.getTime())) {
        //     joinedDate = d.toISOString().split("T")[0]; // YYYY-MM-DD
        //   }
        // }

        
  
        return {
          uid: doc.id,
          name: data.fullName || data.displayName || "",
          email: data.email || "",
          role: data.isAnonymous ? "Guest" : (data?.isAdmin === true ? "Admin" : "Client"),
          status: data.disabled ? "Inactive" : "Active",
          joinedDate,
          credits: data.credits || 0,
        };
      });
  
      // Cursor helpers (use the visible docs for cursors)
      const makeCursor = (doc) =>
        Buffer.from(JSON.stringify({ docId: doc.id })).toString("base64");
  
      const firstDoc = docs[0];
      const lastDoc = docs[docs.length - 1];
  
      const firstCursor = firstDoc ? makeCursor(firstDoc) : null;
      const lastCursor = lastDoc ? makeCursor(lastDoc) : null;
  
      // Compute hasNext/hasPrev consistently
      let hasNextPage = false;
      let hasPrevPage = false;
      if (direction === "prev") {
        hasPrevPage = fetchedMore; // if we fetched more, still earlier pages exist
        hasNextPage = !!cursor; // we came from a newer page so next exists
      } else {
        hasNextPage = fetchedMore; // fetched extra => more pages after
        hasPrevPage = !!cursor; // cursor existence implies previous page exists
      }
  
      // Build response
      const response = {
        users,
        pagination: {
          limit,
          direction,
          hasNextPage,
          hasPrevPage,
          nextCursor: hasNextPage ? lastCursor : null,
          prevCursor: hasPrevPage ? firstCursor : null,
        },
      };
  
      console.log("[USER MANAGEMENT] Returning", users.length, "users. pagination:", response.pagination);
      return successResponse(res, "All users retrieved successfully.", response);
    } catch (error) {
      console.error("[USER MANAGEMENT] Error fetching users:", error);
      return serverErrorResponse(res, error.message);
    }
  };
  
  

export const getUserById = async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return badRequestResponse(res, "User ID is required");
        }

        console.log(`[USER MANAGEMENT] Fetching user with ID: ${userId}`);
        
        // Get user from Firebase Auth
        const userRecord = await admin.auth().getUser(userId);
        
        // Check if user is anonymous
        const isAnonymous = userRecord.providerData.length === 0 || 
                           userRecord.providerData.some(provider => provider.providerId === 'anonymous');
        
        // Determine role based on anonymous status
        const role = isAnonymous ? 'Guest' : 'Client';
        
        // Set name and email based on anonymous status
        const name = isAnonymous ? '' : (userRecord.displayName || '');
        const email = isAnonymous ? 'anonymous' : (userRecord.email || '');
        
        // Get creation date
        const createdAt = userRecord.metadata.creationTime ? 
            new Date(userRecord.metadata.creationTime).toISOString().split('T')[0] : 
            null;

        const user = {
            uid: userRecord.uid,
            name: name,
            email: email,
            role: role,
            status: userRecord.disabled ? 'Inactive' : 'Active',
            joinedDate: createdAt,
            credits: 0 // Set to 0 as requested, will be implemented later
        };

        console.log(`[USER MANAGEMENT] Successfully retrieved user: ${userRecord.uid}`);
        return successResponse(res, "User retrieved successfully.", user);
        
    } catch (error) {
        console.error('[USER MANAGEMENT] Error fetching user:', error);
        if (error.code === 'auth/user-not-found') {
            return notFoundResponse(res, "User not found");
        }
        return serverErrorResponse(res, error.message);
    }
};

export const deleteUser = async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return badRequestResponse(res, "User ID is required");
        }

        console.log(`[USER MANAGEMENT] Deleting user with ID: ${userId}`);

        // First, check if user exists in Firebase Auth
        let userRecord;
        try {
            userRecord = await admin.auth().getUser(userId);
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                return notFoundResponse(res, "User not found in Firebase Auth");
            }
            throw error;
        }

        // Check if user exists in Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return notFoundResponse(res, "User not found in database");
        }

        const userData = userDoc.data();
        const userName = userData.fullName || userData.displayName || userRecord.displayName || 'Unknown User';
        const userEmail = userData.email || userRecord.email || 'No email';

        // Delete user from Firebase Auth
        await admin.auth().deleteUser(userId);

        // Delete user document from Firestore
        await db.collection('users').doc(userId).delete();

        console.log(`[USER MANAGEMENT] Successfully deleted user: ${userId} (${userName})`);

        return successResponse(res, "User deleted successfully", {
            deletedUserId: userId,
            userName: userName,
            userEmail: userEmail,
            deletedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('[USER MANAGEMENT] Error deleting user:', error);
        
        // Handle specific Firebase Auth errors
        if (error.code === 'auth/user-not-found') {
            return notFoundResponse(res, "User not found");
        } else if (error.code === 'auth/insufficient-permissions') {
            return serverErrorResponse(res, "Insufficient permissions to delete user");
        } else if (error.code === 'auth/user-disabled') {
            return serverErrorResponse(res, "Cannot delete disabled user");
        }
        
        return serverErrorResponse(res, error.message);
    }
};
