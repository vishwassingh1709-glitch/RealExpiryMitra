/**
 * Scan history repository storing audit log of OCR/barcode scans.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");

const COLLECTION = "scan_history";
const JSON_FILE = "scan_history.json";
const MAX_HISTORY_ITEMS = 50;

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

async function recordScan(entry) {
  const db = getFirestoreDb();
  const id = entry.id || `scan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    ...entry,
    store_id: entry.store_id || "store_default",
    id,
    timestamp: entry.timestamp || new Date().toISOString()
  };

  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(id).set(record);
    return record;
  }

  const items = await read(JSON_FILE, []);
  items.unshift(record); // Prepend so most recent is first
  if (items.length > MAX_HISTORY_ITEMS) {
    items.length = MAX_HISTORY_ITEMS; // Bound history retention
  }
  await write(JSON_FILE, items);
  return record;
}

async function getRecentScans(limit = 20, storeId = "store_default") {
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    const snapshot = await db
      .collection(COLLECTION)
      .where("store_id", "==", storeId)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get()
      .catch(async () => {
        // In case index not built yet, fallback to un-ordered fetch
        return db.collection(COLLECTION).where("store_id", "==", storeId).limit(limit).get();
      });

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  const items = await read(JSON_FILE, []);
  return items.filter((item) => (item.store_id || "store_default") === storeId).slice(0, limit);
}

module.exports = {
  recordScan,
  getRecentScans
};
