/**
 * Inventory service for managing tracked product records.
 * Full CRUD, dashboard metrics calculation, and lifecycle management.
 */

const repo = require("../repositories/inventory.repository");
const productRepo = require("../repositories/product.repository");

/**
 * Calculates days remaining until expiry and categorical status.
 * @param {string} expiryDate - YYYY-MM-DD
 * @returns {{ days_left: number, status: "expired"|"expiring_soon"|"safe" }}
 */
function statusFor(expiryDate) {
  if (!expiryDate || typeof expiryDate !== "string") {
    return { days_left: 0, status: "expired" };
  }

  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) {
    return { days_left: 0, status: "expired" };
  }

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );

  const days_left = Math.ceil((expiry.getTime() - todayUtc) / 86400000);

  let status = "expired";
  if (days_left > 7) {
    status = "safe";
  } else if (days_left >= 1) {
    status = "expiring_soon";
  }

  return { days_left, status };
}

function computed(item) {
  if (!item) return null;
  const statusInfo = statusFor(item.expiry_date);
  const minStock = Number(item.min_threshold || item.min_stock) || 10;
  const is_low_stock = Number(item.quantity) <= minStock;
  return { ...item, ...statusInfo, min_threshold: minStock, is_low_stock };
}

function normalizedQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : null;
}

/**
 * Saves a new inventory item with metadata.
 */
async function create(data) {
  const quantity = normalizedQuantity(data.quantity) || 1;
  const barcode = String(data.barcode || "").trim();
  const productName = String(data.product_name || "").trim();

  const item = {
    id: data.id || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    barcode,
    product_name: productName,
    brand: data.brand ? String(data.brand).trim() : "",
    category: data.category ? String(data.category).trim() : "Other",
    batch: data.batch ? String(data.batch).trim() : null,
    mfg_date: data.mfg_date || null,
    expiry_date: data.expiry_date,
    quantity,
    confidence: typeof data.confidence === "number" ? data.confidence : null,
    source: data.source || "ocr",
    review_status: data.review_status || "confirmed",
    created_at: data.created_at || new Date().toISOString()
  };

  // If barcode and product details are present, also ensure product is recorded in product catalog
  if (barcode && productName) {
    await productRepo.save({
      barcode,
      name: productName,
      brand: item.brand,
      category: item.category,
      source: item.source
    }).catch((err) => console.warn("[Product Catalog save error]", err.message));
  }

  return repo.save(item);
}

/**
 * Manual inventory entry handler.
 */
async function createManual(body = {}) {
  const barcode = String(body.barcode || "").trim();
  const productName = String(body.product_name || "").trim();
  const expiryDate = String(body.expiry_date || "").trim();

  if (!barcode || !productName || !expiryDate) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "barcode, product_name and expiry_date are required"
      }
    };
  }

  const quantity = normalizedQuantity(body.quantity || 1);
  if (quantity === null) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "quantity must be a positive integer"
      }
    };
  }

  const item = await create({
    barcode,
    product_name: productName,
    brand: body.brand,
    category: body.category || "Other",
    batch: body.batch,
    mfg_date: body.mfg_date || null,
    expiry_date: expiryDate,
    quantity,
    confidence: null,
    source: "manual",
    review_status: "confirmed"
  });

  return { httpStatus: 201, body: computed(item) };
}

/**
 * Confirms and persists an inventory item after user review.
 */
async function confirmSave(body = {}) {
  const barcode = String(body.barcode || "").trim();
  const productName = String(body.product_name || "").trim();
  const expiryDate = String(body.expiry_date || "").trim();

  if (body.record_id) {
    const existing = await repo.get(body.record_id);
    if (existing) {
      return { httpStatus: 200, body: computed(existing) };
    }
  }

  if (!barcode || !productName || !expiryDate) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "barcode, product_name and expiry_date are required to save"
      }
    };
  }

  const quantity = normalizedQuantity(body.quantity || 1) || 1;

  const item = await create({
    id: body.id,
    barcode,
    product_name: productName,
    brand: body.brand || "",
    category: body.category || "Other",
    batch: body.batch || null,
    mfg_date: body.mfg_date || null,
    expiry_date: expiryDate,
    quantity,
    confidence: typeof body.confidence === "number" ? body.confidence : null,
    source: body.source || "ocr",
    review_status: "confirmed"
  });

  return { httpStatus: 201, body: computed(item) };
}

/**
 * List inventory items with optional search and filtering.
 */
async function list(options = {}) {
  const items = await repo.list(options);
  let computedItems = items.map(computed);

  if (options.status && options.status !== "all") {
    if (options.status === "low_stock") {
      computedItems = computedItems.filter((item) => item.is_low_stock);
    } else {
      computedItems = computedItems.filter((item) => item.status === options.status);
    }
  }

  return computedItems;
}

/**
 * Get item by ID.
 */
async function get(id) {
  const item = await repo.get(id);
  return item ? computed(item) : null;
}

/**
 * Update item by ID.
 */
async function update(id, updates = {}) {
  const existing = await repo.get(id);
  if (!existing) return null;

  const payload = {};
  if (updates.product_name) payload.product_name = String(updates.product_name).trim();
  if (updates.brand !== undefined) payload.brand = String(updates.brand).trim();
  if (updates.category) payload.category = String(updates.category).trim();
  if (updates.batch !== undefined) payload.batch = updates.batch ? String(updates.batch).trim() : null;
  if (updates.mfg_date !== undefined) payload.mfg_date = updates.mfg_date || null;
  if (updates.expiry_date) payload.expiry_date = updates.expiry_date;
  if (updates.min_threshold !== undefined) payload.min_threshold = Number(updates.min_threshold) || 10;
  if (updates.quantity !== undefined) {
    const q = normalizedQuantity(updates.quantity);
    if (q !== null) payload.quantity = q;
  }

  const updatedItem = await repo.update(id, payload);
  return updatedItem ? computed(updatedItem) : null;
}

/**
 * Delete item by ID.
 */
async function remove(id) {
  return repo.remove(id);
}

/**
 * Aggregates dashboard statistics from live database records.
 */
async function getSummary() {
  const allItems = await list();

  let safeCount = 0;
  let expiringSoonCount = 0;
  let expiredCount = 0;
  let lowStockCount = 0;
  const categoryCounts = {};

  allItems.forEach((item) => {
    if (item.status === "safe") safeCount += 1;
    else if (item.status === "expiring_soon") expiringSoonCount += 1;
    else if (item.status === "expired") expiredCount += 1;

    if (item.is_low_stock) lowStockCount += 1;

    const cat = item.category || "Other";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  // Attention items: expired or expiring soon, sorted by earliest expiry
  const attentionItems = allItems
    .filter((item) => item.status === "expired" || item.status === "expiring_soon")
    .sort((a, b) => (a.expiry_date || "").localeCompare(b.expiry_date || ""))
    .slice(0, 10);

  // Recent items: sorted by created_at descending
  const recentItems = [...allItems]
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, 10);

  return {
    totalProducts: allItems.length,
    safeCount,
    expiringSoonCount,
    expiredCount,
    lowStockCount,
    attentionItems,
    recentItems,
    categoryCounts
  };
}

module.exports = {
  create,
  createManual,
  confirmSave,
  list,
  get,
  update,
  remove,
  getSummary,
  statusFor,
  computed
};
