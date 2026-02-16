import admin from "firebase-admin";
import { setUserRole, clearAllCustomClaims, db } from "../../services/firebase.service.js";



export const makeAdmin = async (req, res) => {
  const { uid } = req.body;

  if (!uid) {
    return res.status(400).json({
      success: false,
      message: "Missing 'uid' in request body."
    });
  }

  try {
    // Optional: verify user exists in Firebase Auth
    try {
      await admin.auth().getUser(uid);
    } catch (err) {
      // If user not found, return 404
      if (err.code === 'auth/user-not-found' || /user-not-found/i.test(err.message)) {
        return res.status(404).json({
          success: false,
          message: `User ${uid} not found.`,
          error: err.message
        });
      }
      // Otherwise, rethrow to be handled by outer catch
      throw err;
    }

    // Set custom claim (implementation of setUserRole assumed)
    await setUserRole(uid, "admin");

    // Update Firestore user document without overwriting other fields
    await db.collection("users").doc(uid).set(
      { isAdmin: true },
      { merge: true }
    );

    return res.status(200).json({
      success: true,
      message: `User ${uid} has been made an admin.`,
      uid
    });
  } catch (error) {
    console.error("Error making admin:", error);
    const status = (error && error.code === 'auth/user-not-found') ? 404 : 500;

    return res.status(status).json({
      success: false,
      message: "Error making admin.",
      error: error?.message || String(error)
    });
  }
};


export const deleteAdmin = async (req, res)=> {

    const { uid } = req.body;

    try {
        if (!uid) {
            return res.status(400).json({
                success: false,
                message: "Missing 'uid' in request body."
            });
        }
        // Optional: verify user exists in Firebase Auth
        try {
            await admin.auth().getUser(uid);
        } catch (err) {
            // If user not found, return 404
            if (err.code === 'auth/user-not-found' || /user-not-found/i.test(err.message)) {
                return res.status(404).json({
                    success: false,
                    message: `User ${uid} not found.`,
                    error: err.message
                });
            }
            // Otherwise, rethrow to be handled by outer catch
            throw err;
        }
        // Clear custom claims (implementation of clearAllCustomClaims assumed)
        await clearAllCustomClaims(uid);
        // Update Firestore user document without overwriting other fields
        await db.collection("users").doc(uid).set(
            { isAdmin: false },
            { merge: true }
        );
        res.status(200).json({
            success: true,
            message: `User ${uid} has been removed from admin.`,
            uid: uid
        });
    } catch (error) {
        console.error("Error removing admin:", error);
        const status = (error && error.code === 'auth/user-not-found') ? 404 : 500;

        return res.status(status).json({
            success: false,
            message: "Error removing admin.",
            error: error.message
        });
    }
}


