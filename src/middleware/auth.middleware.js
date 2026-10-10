/**
 * Verifies Firebase Auth ID tokens and requires a store owner claim.
 */

const { getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!getApps().length) {
    return res.status(503).json({ status: "error", message: "Authentication is not configured." });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Sign in to continue." });
  }

  try {
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return res.status(401).json({ status: "error", message: "Sign in to continue." });

    const decodedToken = await getAuth().verifyIdToken(token, true);
    if (
      decodedToken.role !== "shopkeeper" ||
      !decodedToken.store_id ||
      decodedToken.store_id !== decodedToken.uid
    ) {
      return res.status(403).json({ status: "error", message: "This account does not have a valid store workspace." });
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || "",
      store_id: decodedToken.store_id,
      role: decodedToken.role
    };
    return next();
  } catch (_) {
    return res.status(401).json({ status: "error", message: "Your session expired. Please sign in again." });
  }
}

module.exports = { requireAuth };
