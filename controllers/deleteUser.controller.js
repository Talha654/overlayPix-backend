import { db, deleteUser } from "../services/firebase.service.js";


export const deleteUser2 = async (req, res)=> {

    const { uid } = req.body;

    try {
        if (!uid) {
            return res.status(400).json({
                success: false,
                message: "Missing 'uid' in request body."
            });
        }
        // Optional: verify user exists in Firebase Auth
       
        // Clear custom claims (implementation of clearAllCustomClaims assumed)
        await deleteUser(uid);
        // Update Firestore user document without overwriting other fields
       
        res.status(200).json({
            success: true,
            message: `User ${uid} has been deleted.`,
            uid: uid
        });
    } catch (error) {
        console.error("Error removing admin:", error);
        const status = (error && error.code === 'auth/user-not-found') ? 404 : 500;

        return res.status(status).json({
            success: false,
            message: "Error deleting user.",
            error: error.message
        });
    }
}