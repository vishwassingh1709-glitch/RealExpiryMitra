const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");

const documents = new Map();
const db = {
  collection(name) {
    const prefix = `${name}/`;
    return {
      doc(id) {
        const key = `${prefix}${id}`;
        return {
          async get() {
            const value = documents.get(key);
            return { exists: Boolean(value), id, data: () => value };
          },
          async set(value, options = {}) {
            documents.set(key, options.merge ? { ...(documents.get(key) || {}), ...value } : value);
          },
          async delete() {
            documents.delete(key);
          }
        };
      },
      where(field, operator, value) {
        const filters = [[field, operator, value]];
        return {
          where(nextField, nextOperator, nextValue) { filters.push([nextField, nextOperator, nextValue]); return this; },
          limit() { return this; },
          async get() {
            const matching = [...documents.entries()].filter(([key, record]) => key.startsWith(prefix) && filters.every(([filterField, filterOperator, expected]) => filterOperator === "==" && record[filterField] === expected));
            return { empty: matching.length === 0, docs: matching.map(([key, record]) => ({ id: key.slice(prefix.length), data: () => record })) };
          }
        };
      }
    };
  }
};

const firestoreModule = require("../src/repositories/firestore");
const originalGetFirestoreDb = firestoreModule.getFirestoreDb;
firestoreModule.getFirestoreDb = () => db;
process.env.STORAGE_PROVIDER = "auto";
const productRepo = require("../src/repositories/product.repository");
const inventoryRepo = require("../src/repositories/inventory.repository");

test("Firestore product repository persists and deduplicates equivalent UPC/EAN identifiers", async () => {
  const first = await productRepo.save({ barcode: "036000291452", name: "Confirmed product", brand: "Trusted brand", category: "Food", source: "manual" });
  const updated = await productRepo.save({ barcode: "0036000291452", name: "Confirmed product revised", brand: "", category: "Other", source: "manual" });
  assert.equal(first.barcode, "0036000291452");
  assert.equal(updated.brand, "Trusted brand");
  assert.equal(updated.verification_status, "confirmed");
  assert.equal(documents.size, 1);
  assert.equal((await productRepo.get("036000291452")).name, "Confirmed product revised");
});

test("Firestore inventory repository persists confirmed batch date metadata", async () => {
  const storeId = "firestore-date-store";
  const id = "firestore-date-batch";
  const saved = await inventoryRepo.save({
    id,
    barcode: "3017620422003",
    product_name: "Firestore date test fixture",
    batch: "LOT-8",
    mfg_date: "2026-01-15",
    expiry_date: "2026-07-15",
    date_metadata: { raw_visible_text: "MFG 15/01/2026", verification_status: "shopkeeper_confirmed", candidates: [{ date_type: "expiry_date", raw_value: "15/07/2026", normalized_date: "2026-07-15", precision: "day", source: "tesseract" }] }
  }, storeId);
  const readBack = await inventoryRepo.get(id, storeId);
  assert.equal(saved.batch, "LOT-8");
  assert.equal(readBack.date_metadata.verification_status, "shopkeeper_confirmed");
  assert.equal(readBack.date_metadata.candidates[0].precision, "day");
  assert.equal(await inventoryRepo.remove(id, storeId), true);
});

test.after(() => { firestoreModule.getFirestoreDb = originalGetFirestoreDb; });
