/**
 * Authentication and authorization middleware.
 * Verifies Firebase Auth ID tokens when present.
 * Falls back safely to default store credentials for offline and testing mode.
 */

const admin = require("firebase-admin");

async function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const idToken = authHeader.split("Bearer ")[1];
    if (admin.apps.length) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = {
          uid: decodedToken.uid,
          email: decodedToken.email || "",
          store_id: decodedToken.store_id || "store_default",
          role: decodedToken.role || "shopkeeper"
        };
        return next();
      } catch (err) {
        console.warn("[Auth] Token verification failed:", err.message);
      }
    }
  }

  // Default guest/local session context
  req.user = {
    uid: "local_user",
    email: "sharmastore@example.com",
    store_id: "store_default",
    role: "shopkeeper"
  };
  return next();
}

module.exports = {
  optionalAuth
};
