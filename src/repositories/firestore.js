/**
 * Firebase Firestore connection and initialization module.
 * Uses Firebase Admin SDK with secure credential loading.
 */

const { applicationDefault, cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

let db = null;
let isInitialized = false;
let initError = null;

function formatPrivateKey(key) {
  if (!key) return undefined;
  // Handle escaped newlines from .env variables
  return key.replace(/\\n/g, "\n");
}

function initializeFirestore() {
  if (isInitialized) {
    return { db, isConnected: Boolean(db), error: initError };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = formatPrivateKey(rawKey);

  // If service account credentials are provided via environment variables
  if (projectId && clientEmail && privateKey) {
    try {
      if (!getApps().length) {
        initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey
          })
        });
      }
      db = getFirestore();
      db.settings({ ignoreUndefinedProperties: true });
      isInitialized = true;
      initError = null;
      console.log(`[Firestore] Connected to project: ${projectId}`);
    } catch (err) {
      initError = err.message;
      isInitialized = true;
      console.warn(`[Firestore] Initialization failed: ${err.message}`);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // If a service account file path is specified
    try {
      if (!getApps().length) {
        initializeApp({
          credential: applicationDefault()
        });
      }
      db = getFirestore();
      db.settings({ ignoreUndefinedProperties: true });
      isInitialized = true;
      initError = null;
      console.log("[Firestore] Connected via application default credentials");
    } catch (err) {
      initError = err.message;
      isInitialized = true;
      console.warn(`[Firestore] Initialization failed: ${err.message}`);
    }
  } else {
    initError = "Firebase credentials not configured in environment variables";
    isInitialized = true;
  }

  return { db, isConnected: Boolean(db), error: initError };
}

function getFirestoreDb() {
  if (!isInitialized) {
    initializeFirestore();
  }
  return db;
}

function getFirestoreStatus() {
  if (!isInitialized) {
    initializeFirestore();
  }
  return {
    configured: Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL),
    connected: Boolean(db),
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    error: initError
  };
}

module.exports = {
  initializeFirestore,
  getFirestoreDb,
  getFirestoreStatus
};
