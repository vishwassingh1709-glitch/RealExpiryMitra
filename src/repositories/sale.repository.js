/**
 * Sales repository supporting both Google Cloud Firestore and local JSON storage.
 * Handles concurrency-safe stock deduction and persistent sales transaction records.
 */

const { getFirestoreDb } = require("./firestore");
const { read, write } = require("./storage");
const inventoryRepo = require("./inventory.repository");

const COLLECTION = "sales";
const JSON_FILE = "sales.json";
const INVENTORY_COLLECTION = "inventory";
const INVENTORY_JSON_FILE = "inventory.json";

function isFirestoreActive() {
  const provider = (process.env.STORAGE_PROVIDER || "").toLowerCase();
  if (provider === "json") return false;
  return Boolean(getFirestoreDb());
}

/**
 * Creates a sale transaction safely reducing inventory stock.
 * Uses a Firestore transaction when Firestore is active.
 * Uses atomic read-modify-write for local JSON storage.
 * 
 * @param {object} saleData
 * @returns {Promise<{ sale: object, updatedInventory: object }>}
 */
async function recordSale(saleData) {
  const { inventory_id, quantity_sold, unit_price = 0, store_id = "store_default", notes = "" } = saleData;
  const quantity = Math.floor(Number(quantity_sold));

  if (!inventory_id) {
    throw new Error("inventory_id is required for a sale");
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("quantity_sold must be a positive integer");
  }

  const db = getFirestoreDb();
  const timestamp = new Date().toISOString();
  const saleId = saleData.id || `sale_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const price = Number(unit_price) >= 0 ? Number(unit_price) : 0;
  const totalAmount = Math.round(price * quantity * 100) / 100;

  if (isFirestoreActive() && db) {
    // Firestore atomic transaction
    const invRef = db.collection(INVENTORY_COLLECTION).doc(inventory_id);
    const saleRef = db.collection(COLLECTION).doc(saleId);

    return db.runTransaction(async (transaction) => {
      const invDoc = await transaction.get(invRef);
      if (!invDoc.exists) {
        throw new Error("Inventory item not found");
      }

      const invData = invDoc.data();
      const currentStock = Number(invData.quantity) || 0;

      if (currentStock < quantity) {
        throw new Error(`Insufficient stock: requested ${quantity}, available ${currentStock}`);
      }

      const newStock = currentStock - quantity;
      transaction.update(invRef, {
        quantity: newStock,
        updated_at: timestamp
      });

      const saleRecord = {
        id: saleId,
        store_id,
        inventory_id,
        barcode: invData.barcode || "",
        product_name: invData.product_name || "Unknown Product",
        brand: invData.brand || "",
        category: invData.category || "Other",
        batch: invData.batch || null,
        expiry_date: invData.expiry_date || null,
        quantity_sold: quantity,
        unit_price: price,
        total_amount: totalAmount,
        notes,
        timestamp,
        created_at: timestamp
      };

      transaction.set(saleRef, saleRecord);

      return {
        sale: saleRecord,
        updatedInventory: { ...invData, id: invDoc.id, quantity: newStock, updated_at: timestamp }
      };
    });
  }

  // Local JSON fallback with atomic check
  const inventoryItems = await read(INVENTORY_JSON_FILE, []);
  const invIndex = inventoryItems.findIndex((item) => item.id === inventory_id);

  if (invIndex === -1) {
    throw new Error("Inventory item not found");
  }

  const currentItem = inventoryItems[invIndex];
  const currentStock = Number(currentItem.quantity) || 0;

  if (currentStock < quantity) {
    throw new Error(`Insufficient stock: requested ${quantity}, available ${currentStock}`);
  }

  const newStock = currentStock - quantity;
  currentItem.quantity = newStock;
  currentItem.updated_at = timestamp;
  inventoryItems[invIndex] = currentItem;

  const saleRecord = {
    id: saleId,
    store_id,
    inventory_id,
    barcode: currentItem.barcode || "",
    product_name: currentItem.product_name || "Unknown Product",
    brand: currentItem.brand || "",
    category: currentItem.category || "Other",
    batch: currentItem.batch || null,
    expiry_date: currentItem.expiry_date || null,
    quantity_sold: quantity,
    unit_price: price,
    total_amount: totalAmount,
    notes,
    timestamp,
    created_at: timestamp
  };

  const sales = await read(JSON_FILE, []);
  sales.unshift(saleRecord);

  // Persist updated inventory and sale
  await write(INVENTORY_JSON_FILE, inventoryItems);
  await write(JSON_FILE, sales);

  return {
    sale: saleRecord,
    updatedInventory: currentItem
  };
}

/**
 * Lists sales filtered by store and time window.
 * @param {object} options - { store_id, range: 'today'|'this_week'|'this_month'|'all', limit, offset }
 * @returns {Promise<Array>}
 */
async function listSales(options = {}) {
  const { store_id, range = "all", limit = 100, offset = 0 } = options;
  const db = getFirestoreDb();
  let sales = [];

  if (isFirestoreActive() && db) {
    let query = db.collection(COLLECTION);
    if (store_id) {
      query = query.where("store_id", "==", store_id);
    }
    const snapshot = await query.orderBy("timestamp", "desc").get().catch(async () => {
      // Fallback if index not yet generated
      return query.get();
    });
    sales = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    sales = await read(JSON_FILE, []);
    if (store_id) {
      sales = sales.filter((s) => !s.store_id || s.store_id === store_id);
    }
  }

  // Filter by date range
  const now = new Date();
  if (range && range !== "all") {
    sales = sales.filter((sale) => {
      const saleDate = new Date(sale.timestamp || sale.created_at);
      if (Number.isNaN(saleDate.getTime())) return false;

      if (range === "today") {
        return (
          saleDate.getFullYear() === now.getFullYear() &&
          saleDate.getMonth() === now.getMonth() &&
          saleDate.getDate() === now.getDate()
        );
      }
      if (range === "this_week") {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        return saleDate >= startOfWeek;
      }
      if (range === "this_month") {
        return (
          saleDate.getFullYear() === now.getFullYear() &&
          saleDate.getMonth() === now.getMonth()
        );
      }
      return true;
    });
  }

  // Sort descending by timestamp
  sales.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  if (typeof limit === "number" && limit > 0) {
    return sales.slice(offset, offset + limit);
  }

  return sales;
}

/**
 * Calculates summary metrics for sales.
 * @param {object} options - { store_id, range }
 * @returns {Promise<{ totalSales: number, totalRevenue: number, totalUnits: number, recentSales: Array }>}
 */
async function getSalesSummary(options = {}) {
  const allSales = await listSales({ ...options, limit: 1000 });
  const totalSales = allSales.length;
  let totalRevenue = 0;
  let totalUnits = 0;

  for (const sale of allSales) {
    totalRevenue += Number(sale.total_amount) || 0;
    totalUnits += Number(sale.quantity_sold) || 0;
  }

  const recentSales = allSales.slice(0, 10);

  return {
    totalSales,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalUnits,
    recentSales
  };
}

module.exports = {
  recordSale,
  listSales,
  getSalesSummary,
  isFirestoreActive
};
