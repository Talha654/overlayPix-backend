import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
dotenv.config();

// Setup __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// console.log('FIREBASE_SERVICE_ACCOUNT', process.env.FIREBASE_SERVICE_ACCOUNT);

// Try to get service account from environment variable first
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:", error);
  }
}

// Fallback to file if not in environment variable
if (!serviceAccount) {
  try {
    serviceAccount = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../firebaseServiceKey.json"), "utf8")
    );
  } catch (error) {
    console.error("Failed to load firebaseServiceKey.json:", error);
    throw new Error("Firebase service account credentials missing. Set FIREBASE_SERVICE_ACCOUNT env var or ensure firebaseServiceKey.json exists.");
  }
}

// Fix private key formatting (replace literal \n with real newlines)
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}


// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),

});

// Delete a user by UID
export async function deleteUser(uid) {
  try {
    await admin.auth().deleteUser(uid);
    console.log(`Successfully deleted user with UID: ${uid}`);
  } catch (error) {
    console.error("Error deleting user:", error);
  }
}


export async function setUserRole(uid, role) {
  await admin.auth().setCustomUserClaims(uid, { role });
  console.log(`Role "${role}" assigned to user ${uid}`);
}

// removes all custom claims for the user
export async function clearAllCustomClaims(uid) {
  await admin.auth().setCustomUserClaims(uid, null);
  // Revoke refresh tokens so clients get new ID token (without claims)
  await admin.auth().revokeRefreshTokens(uid);
  console.log(`All custom claims removed for ${uid}`);
}

// async function setUserRole(uid, role) {
//   await admin.auth().setCustomUserClaims(uid, { role });
//   console.log(`Role "${role}" assigned to user ${uid}`);
// }

// setUserRole("sy1os6BcZfTocQ7I2dphRQfxdrn2", "admin");

// console.log(setUserRole)

const db = admin.firestore();


// async function addFieldToCollection() {
//   const collectionRef = db.collection("adminOverlays"); // your collection
//   const snapshot = await collectionRef.get();

//   const batch = db.batch();

//   snapshot.forEach(doc => {
//     batch.update(doc.ref, { status: "active" }); // add new field "role"
//   });

//   await batch.commit();
//   console.log("Field added to all docs!");
// }

// addFieldToCollection().catch(console.error);
export { admin, db, };
