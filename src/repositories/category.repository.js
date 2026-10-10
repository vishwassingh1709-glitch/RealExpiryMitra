/**
 * Category repository managing predefined and custom food categories.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");

const COLLECTION = "categories";
const JSON_FILE = "categories.json";

const DEFAULT_CATEGORIES = [
  { id: "dairy", name: "Dairy", icon: "🥛" },
  { id: "fruits", name: "Fruits", icon: "🍎" },
  { id: "vegetables", name: "Vegetables", icon: "🥦" },
  { id: "grains", name: "Grains & Cereals", icon: "🌾" },
  { id: "meat_seafood", name: "Meat & Seafood", icon: "🥩" },
  { id: "frozen", name: "Frozen Food", icon: "❄️" },
  { id: "packaged", name: "Packaged Food", icon: "🥫" },
  { id: "beverages", name: "Beverages", icon: "🧃" },
  { id: "other", name: "Other", icon: "🏷️" }
];

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

async function listCategories() {
  const db = getFirestoreDb();
  if (isFirestoreActive() && db) {
    const snapshot = await db.collection(COLLECTION).get();
    if (!snapshot.empty) {
      return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  }

  const stored = await read(JSON_FILE, null);
  if (!stored || !stored.length) {
    await write(JSON_FILE, DEFAULT_CATEGORIES);
    return DEFAULT_CATEGORIES;
  }
  return stored;
}

async function getCategory(id) {
  const categories = await listCategories();
  return categories.find((c) => c.id === id) || null;
}

module.exports = {
  listCategories,
  getCategory,
  DEFAULT_CATEGORIES
};
