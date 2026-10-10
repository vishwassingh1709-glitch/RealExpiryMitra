/**
 * Store and Profile repository supporting both Google Cloud Firestore and local JSON storage.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");

const COLLECTION = "stores";
const JSON_FILE = "stores.json";

const DEFAULT_STORE = {
  id: "store_default",
  store_name: "Sharma Store",
  phone: "9876543210",
  email: "sharmastore@example.com",
  owner_name: "Sharma Ji",
  owner_uid: "uid_default",
  address: "Shop No. 4, Market Complex, Main Road",
  role: "shopkeeper",
  settings: {
    expiry_warning_days: 7,
    low_stock_threshold: 5,
    currency: "INR",
    currency_symbol: "₹"
  },
  updated_at: new Date().toISOString()
};

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

async function getStore(storeId = "store_default") {
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    const doc = await db.collection(COLLECTION).doc(storeId).get();
    if (doc.exists) {
      return { id: doc.id, ...doc.data() };
    }
    // Initialize default if not exists
    await db.collection(COLLECTION).doc(storeId).set(DEFAULT_STORE);
    return DEFAULT_STORE;
  }

  const stores = await read(JSON_FILE, [DEFAULT_STORE]);
  const found = stores.find((s) => s.id === storeId);
  if (!found) {
    stores.push(DEFAULT_STORE);
    await write(JSON_FILE, stores);
    return DEFAULT_STORE;
  }
  return found;
}

async function updateStore(storeId = "store_default", updates = {}) {
  const current = await getStore(storeId);
  const updated = {
    ...current,
    ...updates,
    id: storeId,
    updated_at: new Date().toISOString()
  };

  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(storeId).set(updated, { merge: true });
    return updated;
  }

  const stores = await read(JSON_FILE, [DEFAULT_STORE]);
  const index = stores.findIndex((s) => s.id === storeId);
  if (index >= 0) {
    stores[index] = updated;
  } else {
    stores.push(updated);
  }
  await write(JSON_FILE, stores);
  return updated;
}

module.exports = {
  getStore,
  updateStore,
  DEFAULT_STORE,
  isFirestoreActive
};
