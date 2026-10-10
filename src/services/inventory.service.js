/**
 * Inventory service for managing tracked product records.
 * Full CRUD, dashboard metrics calculation, and lifecycle management.
 */

const repo = require("../repositories/inventory.repository");
const productRepo = require("../repositories/product.repository");
const { validDate } = require("./validation.service");

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
  const statusInfo = statusFor(item.expiry_date || item.best_before_date);
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
async function create(data, storeId = "store_default") {
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
    packaging_date: data.packaging_date || null,
    expiry_date: data.expiry_date || null,
    best_before_date: data.best_before_date || null,
    date_metadata: data.date_metadata || null,
    quantity,
    store_id: storeId,
    confidence: typeof data.confidence === "number" ? data.confidence : null,
    source: data.source || "ocr",
    review_status: data.review_status || "confirmed",
    created_at: data.created_at || new Date().toISOString()
  };

  // Persist the reviewed inventory record first. Only after it succeeds may the
  // shopkeeper-confirmed identity be added to the reusable product catalog.
  const savedItem = await repo.save(item, storeId);
  if (barcode && productName) {
    await productRepo.save({
      barcode,
      name: productName,
      brand: item.brand,
      category: item.category,
      image_url: data.image_url,
      source: data.product_source || (item.source === "manual" ? "manual" : "inventory_confirmation"),
      source_label: data.product_source === "gemini_candidate"
        ? "Shopkeeper confirmed Gemini suggestion"
        : (data.product_source_label || "Shopkeeper confirmed"),
      verification_status: "confirmed"
    }).catch((err) => console.warn("[Product Catalog save error]", err.message));
  }

  return savedItem;
}

/**
 * Manual inventory entry handler.
 */
async function createManual(body = {}, storeId = "store_default") {
  const barcode = String(body.barcode || "").trim();
  const productName = String(body.product_name || "").trim();
  const expiryDate = String(body.expiry_date || "").trim();
  const bestBeforeDate = String(body.best_before_date || "").trim();

  if (!barcode || !productName || (!expiryDate && !bestBeforeDate)) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "barcode, product_name and either expiry_date or best_before_date are required"
      }
    };
  }

  const mfgDate = String(body.mfg_date || "").trim();
  const packagingDate = String(body.packaging_date || "").trim();
  if ([expiryDate, bestBeforeDate, mfgDate, packagingDate].some((date) => date && !validDate(date))) {
    return { httpStatus: 400, body: { status: "error", message: "Dates must be valid full calendar dates." } };
  }
  const finalDates = [expiryDate, bestBeforeDate].filter(Boolean);
  if (finalDates.some((date) => (mfgDate && date < mfgDate) || (packagingDate && date < packagingDate))) {
    return { httpStatus: 400, body: { status: "error", message: "Expiry or best-before date cannot precede the printed production/packaging date." } };
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
    mfg_date: mfgDate || null,
    packaging_date: packagingDate || null,
    expiry_date: expiryDate || null,
    best_before_date: bestBeforeDate || null,
    date_metadata: normalizeDateMetadata(body.date_metadata),
    quantity,
    confidence: null,
    source: "manual",
    review_status: "confirmed"
  }, storeId);

  return { httpStatus: 201, body: computed(item) };
}

/**
 * Confirms and persists an inventory item after user review.
 */
async function confirmSave(body = {}, storeId = "store_default") {
  const barcode = String(body.barcode || "").trim();
  const productName = String(body.product_name || "").trim();
  const expiryDate = String(body.expiry_date || "").trim();
  const bestBeforeDate = String(body.best_before_date || "").trim();

  if (body.record_id) {
    const existing = await repo.get(body.record_id, storeId);
    if (existing) {
      return { httpStatus: 200, body: computed(existing) };
    }
  }

  if (!barcode || !productName || (!expiryDate && !bestBeforeDate)) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "barcode, product_name and either expiry_date or best_before_date are required to save"
      }
    };
  }

  const mfgDate = String(body.mfg_date || "").trim();
  const packagingDate = String(body.packaging_date || "").trim();
  if ([expiryDate, bestBeforeDate, mfgDate, packagingDate].some((date) => date && !validDate(date))) {
    return { httpStatus: 400, body: { status: "error", message: "Dates must be valid full calendar dates." } };
  }
  const dateValues = [expiryDate, bestBeforeDate].filter(Boolean);
  if (dateValues.some((date) => (mfgDate && date < mfgDate) || (packagingDate && date < packagingDate))) {
    return { httpStatus: 400, body: { status: "error", message: "Expiry or best-before date cannot precede the printed production/packaging date." } };
  }

  const quantity = normalizedQuantity(body.quantity || 1) || 1;

  const item = await create({
    barcode,
    product_name: productName,
    brand: body.brand || "",
    category: body.category || "Other",
    batch: body.batch || null,
    mfg_date: mfgDate || null,
    packaging_date: packagingDate || null,
    expiry_date: expiryDate || null,
    best_before_date: bestBeforeDate || null,
    date_metadata: normalizeDateMetadata(body.date_metadata),
    quantity,
    confidence: typeof body.confidence === "number" ? body.confidence : null,
    image_url: body.image_url || null,
    product_source: body.product_source || null,
    product_source_label: body.product_source_label || null,
    source: body.source || "ocr",
    review_status: "confirmed"
  }, storeId);

  return { httpStatus: 201, body: computed(item) };
}

function normalizeDateMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedTypes = new Set(["manufacturing_date", "packaging_date", "expiry_date", "best_before_date", "batch_number", "best_before_duration"]);
  const candidates = Array.isArray(value.candidates) ? value.candidates.slice(0, 20).flatMap((item) => {
    if (!item || !allowedTypes.has(item.date_type)) return [];
    return [{
      date_type: item.date_type,
      raw_value: typeof item.raw_value === "string" ? item.raw_value.slice(0, 120) : null,
      normalized_date: typeof item.normalized_date === "string" ? item.normalized_date.slice(0, 10) : null,
      precision: ["day", "month"].includes(item.precision) ? item.precision : null,
      date_convention: item.date_convention === "gs1_day_00_end_of_month" ? item.date_convention : null,
      source: ["ocr", "tesseract", "ocr_space", "gemini_image", "gs1_barcode", "derived_from_label", "manual"].includes(item.source) ? item.source : "manual",
      uncertain: Boolean(item.uncertain),
      conflict: Boolean(item.conflict),
      derived: Boolean(item.derived)
    }];
  }) : [];
  return {
    raw_visible_text: typeof value.raw_visible_text === "string" ? value.raw_visible_text.slice(0, 2000) : "",
    candidates,
    extraction_methods: Array.isArray(value.extraction_methods) ? value.extraction_methods.filter((method) => ["tesseract", "ocr_space", "gemini_image", "gs1_barcode", "manual"].includes(method)).slice(0, 4) : [],
    verification_status: "shopkeeper_confirmed",
    confirmed_at: new Date().toISOString()
  };
}

/**
 * List inventory items with optional search and filtering.
 */
async function list(options = {}, storeId = "store_default") {
  const items = await repo.list(options, storeId);
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
async function get(id, storeId = "store_default") {
  const item = await repo.get(id, storeId);
  return item ? computed(item) : null;
}

/**
 * Update item by ID.
 */
async function update(id, updates = {}, storeId = "store_default") {
  const existing = await repo.get(id, storeId);
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

  const updatedItem = await repo.update(id, payload, storeId);
  return updatedItem ? computed(updatedItem) : null;
}

/**
 * Delete item by ID.
 */
async function remove(id, storeId = "store_default") {
  return repo.remove(id, storeId);
}

/**
 * Aggregates dashboard statistics from live database records.
 */
async function getSummary(storeId = "store_default") {
  const allItems = await list({}, storeId);

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
    .sort((a, b) => (a.expiry_date || a.best_before_date || "").localeCompare(b.expiry_date || b.best_before_date || ""))
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
