/**
 * Product repository supporting both Google Cloud Firestore and local JSON storage.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");

const COLLECTION = "products";
const JSON_FILE = "products.json";

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

/**
 * Get product by barcode.
 * @param {string} barcode
 * @returns {Promise<object|null>}
 */
async function get(barcode) {
  if (!barcode) return null;
  const normalizedBarcode = String(barcode).trim();
  const db = getFirestoreDb();

  if (isFirestoreActive() && db) {
    const doc = await db.collection(COLLECTION).doc(normalizedBarcode).get();
    if (doc.exists) {
      return { id: doc.id, ...doc.data() };
    }
    // Also try barcode query if document ID wasn't barcode
    const snapshot = await db.collection(COLLECTION).where("barcode", "==", normalizedBarcode).limit(1).get();
    if (!snapshot.empty) {
      const firstDoc = snapshot.docs[0];
      return { id: firstDoc.id, ...firstDoc.data() };
    }
    return null;
  }

  const products = await read(JSON_FILE, []);
  return products.find((p) => p.barcode === normalizedBarcode) || null;
}

/**
 * Save or update a product.
 * @param {object} product
 * @returns {Promise<object>}
 */
async function save(product) {
  const normalizedBarcode = String(product.barcode || "").trim();
  const timestamp = new Date().toISOString();
  const record = {
    id: product.id || `prod_${normalizedBarcode}`,
    barcode: normalizedBarcode,
    name: product.name ? String(product.name).trim() : "Unknown product",
    brand: product.brand ? String(product.brand).trim() : "",
    category: product.category ? String(product.category).trim() : "Other",
    image_url: product.image_url || null,
    source: product.source || "local",
    created_at: product.created_at || timestamp,
    updated_at: timestamp
  };

  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(record.barcode).set(record, { merge: true });
    return record;
  }

  const products = await read(JSON_FILE, []);
  const index = products.findIndex((p) => p.barcode === record.barcode);
  if (index >= 0) {
    products[index] = { ...products[index], ...record };
  } else {
    products.push(record);
  }
  await write(JSON_FILE, products);
  return record;
}

/**
 * Search products by name, brand, or barcode.
 * @param {string} query
 * @returns {Promise<Array>}
 */
async function search(query) {
  if (!query) return [];
  const q = String(query).toLowerCase().trim();
  const db = getFirestoreDb();

  let products = [];
  if (isFirestoreActive() && db) {
    const snapshot = await db.collection(COLLECTION).get();
    products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } else {
    products = await read(JSON_FILE, []);
  }

  return products.filter(
    (p) =>
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.brand && p.brand.toLowerCase().includes(q)) ||
      (p.barcode && p.barcode.includes(q))
  );
}

/**
 * List all products.
 * @returns {Promise<Array>}
 */
async function list() {
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    const snapshot = await db.collection(COLLECTION).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return read(JSON_FILE, []);
}

/**
 * Update product details.
 */
async function update(barcodeOrId, partial = {}) {
  const existing = await get(barcodeOrId);
  if (!existing) return null;

  const updatedRecord = {
    ...existing,
    ...partial,
    updated_at: new Date().toISOString()
  };

  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(existing.barcode || existing.id).set(updatedRecord, { merge: true });
    return updatedRecord;
  }

  const products = await read(JSON_FILE, []);
  const index = products.findIndex((p) => p.barcode === existing.barcode || p.id === existing.id);
  if (index >= 0) {
    products[index] = updatedRecord;
    await write(JSON_FILE, products);
    return updatedRecord;
  }
  return null;
}

/**
 * Delete product from catalog.
 */
async function remove(barcodeOrId) {
  const existing = await get(barcodeOrId);
  if (!existing) return false;

  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(existing.barcode || existing.id).delete();
    return true;
  }

  const products = await read(JSON_FILE, []);
  const initialLen = products.length;
  const filtered = products.filter((p) => p.barcode !== existing.barcode && p.id !== existing.id);
  if (filtered.length !== initialLen) {
    await write(JSON_FILE, filtered);
    return true;
  }
  return false;
}

module.exports = {
  get,
  save,
  search,
  list,
  update,
  remove
};
