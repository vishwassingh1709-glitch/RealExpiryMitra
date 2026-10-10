/**
 * Inventory repository supporting both Google Cloud Firestore and local JSON storage.
 * Automatically uses Firestore when configured; safely falls back to local storage for offline development/tests.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");

const COLLECTION = "inventory";
const JSON_FILE = "inventory.json";

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

/**
 * Save an inventory record.
 * @param {object} item
 * @returns {Promise<object>}
 */
async function save(item) {
  const db = getFirestoreDb();
  const timestamp = new Date().toISOString();
  const record = {
    ...item,
    created_at: item.created_at || timestamp,
    updated_at: timestamp
  };

  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(record.id).set(record, { merge: true });
    return record;
  }

  // Local JSON fallback
  const items = await read(JSON_FILE, []);
  const index = items.findIndex((i) => i.id === record.id);
  if (index >= 0) {
    items[index] = { ...items[index], ...record };
  } else {
    items.push(record);
  }
  await write(JSON_FILE, items);
  return record;
}

/**
 * List inventory items with optional search, filtering, and sorting.
 * @param {object} [options]
 * @returns {Promise<Array>}
 */
async function list(options = {}) {
  const { search, category, status, sortBy = "created_desc", limit, offset = 0 } = options;
  const db = getFirestoreDb();

  let items = [];

  if (isFirestoreActive() && db) {
    const snapshot = await db.collection(COLLECTION).get();
    items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } else {
    items = await read(JSON_FILE, []);
  }

  // In-memory filtering and sorting (applies uniformly to both backends)
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter(
      (item) =>
        (item.product_name && item.product_name.toLowerCase().includes(q)) ||
        (item.barcode && item.barcode.includes(q)) ||
        (item.brand && item.brand.toLowerCase().includes(q)) ||
        (item.batch && item.batch.toLowerCase().includes(q))
    );
  }

  if (category && category !== "all") {
    const cat = String(category).toLowerCase();
    items = items.filter(
      (item) => item.category && item.category.toLowerCase() === cat
    );
  }

  // Sorting
  items.sort((a, b) => {
    if (sortBy === "expiry_asc") {
      return (a.expiry_date || "").localeCompare(b.expiry_date || "");
    }
    if (sortBy === "expiry_desc") {
      return (b.expiry_date || "").localeCompare(a.expiry_date || "");
    }
    if (sortBy === "name_asc") {
      return (a.product_name || "").localeCompare(b.product_name || "");
    }
    // Default: created_desc
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  if (typeof limit === "number" && limit > 0) {
    return items.slice(offset, offset + limit);
  }

  return items;
}

/**
 * Get single inventory record by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function get(id) {
  if (!id) return null;
  const db = getFirestoreDb();

  if (isFirestoreActive() && db) {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  const items = await read(JSON_FILE, []);
  return items.find((item) => item.id === id) || null;
}

/**
 * Update an inventory item by ID.
 * @param {string} id
 * @param {object} partial
 * @returns {Promise<object|null>}
 */
async function update(id, partial) {
  if (!id) return null;
  const db = getFirestoreDb();
  const existing = await get(id);
  if (!existing) return null;

  const updatedRecord = {
    ...existing,
    ...partial,
    id, // guarantee id stays intact
    updated_at: new Date().toISOString()
  };

  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(id).set(updatedRecord, { merge: true });
    return updatedRecord;
  }

  const items = await read(JSON_FILE, []);
  const index = items.findIndex((i) => i.id === id);
  if (index >= 0) {
    items[index] = updatedRecord;
    await write(JSON_FILE, items);
    return updatedRecord;
  }

  return null;
}

/**
 * Remove an inventory item by ID.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function remove(id) {
  if (!id) return false;
  const db = getFirestoreDb();

  if (isFirestoreActive() && db) {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  const items = await read(JSON_FILE, []);
  const initialLength = items.length;
  const filtered = items.filter((item) => item.id !== id);
  if (filtered.length !== initialLength) {
    await write(JSON_FILE, filtered);
    return true;
  }
  return false;
}

/**
 * Get inventory record by barcode.
 * @param {string} barcode
 * @returns {Promise<object|null>}
 */
async function getByBarcode(barcode) {
  if (!barcode) return null;
  const normalizedBarcode = String(barcode).trim();
  const db = getFirestoreDb();

  if (isFirestoreActive() && db) {
    const snapshot = await db.collection(COLLECTION).where("barcode", "==", normalizedBarcode).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return { id: doc.id, ...doc.data() };
    }
    return null;
  }

  const items = await read(JSON_FILE, []);
  return items.find((item) => String(item.barcode).trim() === normalizedBarcode) || null;
}

module.exports = {
  save,
  list,
  get,
  getByBarcode,
  update,
  remove,
  isFirestoreActive
};
