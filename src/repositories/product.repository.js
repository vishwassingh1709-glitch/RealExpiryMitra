/**
 * Product repository supporting both Google Cloud Firestore and local JSON storage.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");
const { normalizeBarcode, barcodeCandidates, canonicalBarcode } = require("../utils/barcode");

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
  const normalizedBarcode = normalizeBarcode(barcode);
  const candidates = barcodeCandidates(normalizedBarcode);
  const db = getFirestoreDb();

  if (isFirestoreActive() && db) {
    for (const candidate of candidates) {
      const doc = await db.collection(COLLECTION).doc(candidate).get();
      if (doc.exists) return { id: doc.id, ...doc.data() };
    }
    // Also try barcode query if document ID wasn't barcode
    for (const candidate of candidates) {
      const snapshot = await db.collection(COLLECTION).where("barcode", "==", candidate).limit(1).get();
      if (!snapshot.empty) {
        const firstDoc = snapshot.docs[0];
        return { id: firstDoc.id, ...firstDoc.data() };
      }
    }
    return null;
  }

  const products = await read(JSON_FILE, []);
  return products.find((p) => candidates.includes(normalizeBarcode(p.barcode))) || null;
}

/**
 * Save or update a product.
 * @param {object} product
 * @returns {Promise<object>}
 */
async function save(product) {
  const scannedBarcode = normalizeBarcode(product.barcode);
  if (!scannedBarcode || !String(product.name || "").trim()) throw new Error("A valid barcode and product name are required");
  const normalizedBarcode = canonicalBarcode(scannedBarcode);
  const existing = await get(scannedBarcode);
  const timestamp = new Date().toISOString();
  const record = {
    id: existing?.id || product.id || `prod_${normalizedBarcode}`,
    barcode: normalizedBarcode,
    name: product.name ? String(product.name).trim() : "",
    brand: product.brand ? String(product.brand).trim() : (existing?.brand || ""),
    category: product.category && product.category !== "Other" ? String(product.category).trim() : (existing?.category || (product.category === "Other" ? "Other" : "")),
    image_url: product.image_url || existing?.image_url || null,
    source: product.source === "open_food_facts" || product.source === "external_api" ? "manual" : (product.source || "manual"),
    source_label: product.source_label || "Shopkeeper confirmed",
    verification_status: "confirmed",
    created_at: existing?.created_at || product.created_at || timestamp,
    updated_at: timestamp
  };

  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    await db.collection(COLLECTION).doc(existing?.barcode || record.barcode).set(record, { merge: true });
    return record;
  }

  const products = await read(JSON_FILE, []);
  const candidates = barcodeCandidates(scannedBarcode);
  const index = products.findIndex((p) => candidates.includes(normalizeBarcode(p.barcode)));
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
