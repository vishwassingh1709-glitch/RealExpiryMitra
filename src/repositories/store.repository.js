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

function newStoreRecord(storeId, profile = {}) {
  const base = storeId === "store_default" ? DEFAULT_STORE : {
    id: storeId,
    store_name: "My Store",
    phone: "",
    email: "",
    owner_name: "Store owner",
    owner_uid: storeId,
    address: "",
    role: "shopkeeper",
    settings: DEFAULT_STORE.settings
  };
  return {
    ...base,
    ...profile,
    id: storeId,
    owner_uid: storeId,
    updated_at: new Date().toISOString()
  };
}

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
    return createStoreIfMissing(storeId);
  }

  const stores = await read(JSON_FILE, [DEFAULT_STORE]);
  const found = stores.find((s) => s.id === storeId);
  if (found) return found;
  return createStoreIfMissing(storeId);
}

async function createStoreIfMissing(storeId, profile = {}) {
  const record = newStoreRecord(storeId, profile);
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    return db.runTransaction(async (transaction) => {
      const ref = db.collection(COLLECTION).doc(storeId);
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return { id: snapshot.id, ...snapshot.data() };
      transaction.set(ref, record);
      return record;
    });
  }

  const stores = await read(JSON_FILE, [DEFAULT_STORE]);
  const found = stores.find((s) => s.id === storeId);
  if (found) return found;
  stores.push(record);
  await write(JSON_FILE, stores);
  return record;
}

async function deleteStoreIfOwned(storeId, ownerUid) {
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    const ref = db.collection(COLLECTION).doc(storeId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().owner_uid !== ownerUid) return false;
    await ref.delete();
    return true;
  }

  const stores = await read(JSON_FILE, [DEFAULT_STORE]);
  const filtered = stores.filter((store) => !(store.id === storeId && store.owner_uid === ownerUid));
  if (filtered.length === stores.length) return false;
  await write(JSON_FILE, filtered);
  return true;
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
  createStoreIfMissing,
  deleteStoreIfOwned,
  updateStore,
  DEFAULT_STORE,
  isFirestoreActive
};
