const crypto = require("node:crypto");
const productRepo = require("../repositories/product.repository");
const inventoryRepo = require("../repositories/inventory.repository");
const aiService = require("./ai.service");
const groqProductSearch = require("./groq-product-search.service");
const { normalizeBarcode, extractGs1Gtin, barcodeCandidates, isRetailGtin, hasValidGs1CheckDigit } = require("../utils/barcode");

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const LOOKUP_TIMEOUT_MS = positiveTimeout(process.env.PRODUCT_LOOKUP_TIMEOUT_MS, 6000);
const GEMINI_TIMEOUT_MS = positiveTimeout(process.env.PRODUCT_IDENTIFICATION_TIMEOUT_MS, 8000);
const OFF_FIELDS = "code,product_type,product_name,generic_name,brands,categories,categories_hierarchy,image_front_url,image_url";
const identificationsInFlight = new Map();
const offLookupsInFlight = new Map();

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : null;
  } catch (_) { return null; }
}

function bounded(promise, milliseconds, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), milliseconds); })
  ]).finally(() => clearTimeout(timer));
}

function verifiedCatalogRecord(record) {
  if (!record) return false;
  const source = String(record.source || "").toLowerCase();
  return record.verification_status !== "unverified" && !["external_api", "open_food_facts", "gemini_candidate"].includes(source);
}

async function lookupLocalProduct(barcode, candidates, storeId) {
  const catalogReads = candidates.map((candidate) => productRepo.get(candidate).catch((error) => ({ lookupError: error })));
  const inventoryReads = candidates.map((candidate) => inventoryRepo.getByBarcode(candidate, storeId).catch((error) => ({ lookupError: error })));
  const catalogCompletion = Promise.all(catalogReads);
  const firstVerified = Promise.any(catalogReads.map(async (read) => {
    const record = await read;
    if (record && !record.lookupError && verifiedCatalogRecord(record) && String(record.name || record.product_name || "").trim()) return record;
    throw new Error("No verified barcode match in this catalogue record");
  })).then((record) => ({ type: "verified", record }), () => null);
  const firstCatalog = await Promise.race([
    firstVerified,
    catalogCompletion.then((records) => ({ type: "complete", records }))
  ]);
  const catalogRecords = firstCatalog?.records || (firstCatalog?.type === "verified" ? null : await catalogCompletion);
  const catalog = firstCatalog?.type === "verified"
    ? firstCatalog.record
    : (catalogRecords.find((record) => record && !record.lookupError) || null);

  if (catalog && String(catalog.name || catalog.product_name || "").trim() && verifiedCatalogRecord(catalog)) {
    return { status: "found", product: {
      ...catalog,
      barcode,
      name: String(catalog.name || catalog.product_name).trim(),
      quantity: catalog.quantity ?? null,
      source: "catalog",
      source_label: "ExpiryMitra catalog",
      verification_status: "confirmed"
    } };
  }
  const inventoryRecords = await Promise.all(inventoryReads);
  const inventory = inventoryRecords.find((record) => record && !record.lookupError) || null;
  if (inventory && String(inventory.product_name || "").trim() && !["rejected", "needs_review"].includes(inventory.review_status)) {
    return { status: "found", product: {
      id: inventory.id,
      barcode,
      name: String(inventory.product_name).trim(),
      brand: inventory.brand || "",
      category: inventory.category || "",
      quantity: inventory.quantity,
      expiryDate: inventory.expiry_date || null,
      expiry_date: inventory.expiry_date || null,
      batch: inventory.batch || null,
      inventory_id: inventory.id,
      source: "inventory",
      source_label: "Your confirmed inventory",
      verification_status: "confirmed"
    } };
  }
  if (catalogRecords.every((record) => record?.lookupError) && inventoryRecords.every((record) => record?.lookupError)) {
    return { status: "unavailable" };
  }
  return { status: "not_found" };
}

async function lookupOpenFoodFacts(barcode, candidates) {
  if (!isRetailGtin(barcode)) return { status: "not_found" };
  const key = candidates.slice().sort()[0];
  if (offLookupsInFlight.has(key)) return offLookupsInFlight.get(key);
  const task = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveTimeout(process.env.OPEN_FOOD_FACTS_TIMEOUT_MS, LOOKUP_TIMEOUT_MS));
    try {
      const url = new URL(`https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}`);
      url.searchParams.set("product_type", "food");
      url.searchParams.set("cc", "in");
      url.searchParams.set("lc", "en");
      url.searchParams.set("fields", OFF_FIELDS);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": process.env.OPEN_FOOD_FACTS_USER_AGENT || "ExpiryMitra/1.0" }
      });
      if (response.status === 404) return { status: "not_found" };
      if (!response.ok || response.status >= 300) return { status: "unavailable" };
      let data;
      try { data = await response.json(); } catch (_) { return { status: "unavailable" }; }
      if (data?.status !== "success" && data?.status !== 1) {
        return { status: data?.status === "failure" || data?.status === 0 ? "not_found" : "unavailable" };
      }
      const external = data?.product;
      const returnedCode = normalizeBarcode(external?.code || data?.code);
      if (!external || !candidates.includes(returnedCode)) {
        return { status: data?.status === "failure" || data?.status === 0 ? "not_found" : "unavailable" };
      }
      const name = String(external.product_name || external.generic_name || "").trim();
      if (!name) return { status: "not_found" };
      return { status: "found", product: {
        barcode,
        name,
        brand: String(external.brands || "").trim(),
        category: String(external.categories_hierarchy?.[0]?.replace(/^[a-z]{2}:/i, "") || external.categories || "").trim(),
        image_url: safeImageUrl(external.image_front_url || external.image_url),
        source: "open_food_facts",
        source_label: "Open Food Facts",
        verification_status: "unverified"
      } };
    } catch (error) {
      console.warn("Open Food Facts lookup unavailable:", error.name === "AbortError" ? "request timed out" : error.message);
      return { status: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  })();
  offLookupsInFlight.set(key, task);
  try { return await task; } finally { offLookupsInFlight.delete(key); }
}

async function identifyUnshared(barcode, storeId, image) {
  const candidates = barcodeCandidates(barcode);
  const invalidRetailGtin = /^\d+$/.test(barcode) && [8, 12, 13, 14].includes(barcode.length) && !hasValidGs1CheckDigit(barcode);
  const validRetailGtin = isRetailGtin(barcode);
  const localPromise = bounded(lookupLocalProduct(barcode, candidates, storeId), LOOKUP_TIMEOUT_MS, { status: "unavailable" });
  const offPromise = validRetailGtin ? lookupOpenFoodFacts(barcode, candidates) : Promise.resolve({ status: "not_found" });

  const local = await localPromise;
  if (local.status === "found") return local;

  const off = await offPromise;
  if (off.status === "found") return off;

  const groq = await groqProductSearch.lookupBarcodeOnWeb(barcode);
  if (groq.status === "found") return groq;

  let gemini = null;
  if (image && process.env.GEMINI_API_KEY) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    try {
      gemini = await Promise.race([
        aiService.identifyProductFromImage(image, barcode, { signal: controller.signal })
          .catch((error) => {
            if (!timedOut) console.warn("Gemini product suggestion unavailable:", error.name || "request failed");
            return null;
          }),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve(null);
          }, GEMINI_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
      try { controller.abort(); } catch (_) {}
    }
  }
  if (gemini) return { status: "found", product: gemini };

  const remoteUnavailable = [off.status, groq.status].some((status) => ["unavailable", "timeout", "rate_limited", "unsupported_model", "malformed_response"].includes(status));
  if (remoteUnavailable || local.status === "unavailable") return { status: "unavailable" };
  if (invalidRetailGtin) return { status: "invalid" };
  return { status: "not_found" };
}

async function identifyProduct(barcode, storeId = "store_default", image = null) {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode) return { status: "invalid" };
  const lookupBarcode = extractGs1Gtin(normalizedBarcode) || normalizedBarcode;
  if (image !== null && (typeof image !== "string" || image.length > 10 * 1024 * 1024 || !/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(image))) {
    return { status: "invalid_image" };
  }
  const imageKey = image ? crypto.createHash("sha256").update(image).digest("hex") : "no-image";
  const key = `${storeId}:${barcodeCandidates(lookupBarcode).slice().sort()[0]}:${imageKey}`;
  if (identificationsInFlight.has(key)) return identificationsInFlight.get(key);
  const task = identifyUnshared(lookupBarcode, storeId, image);
  identificationsInFlight.set(key, task);
  try { return await task; } finally { identificationsInFlight.delete(key); }
}

async function findProduct(barcode, storeId = "store_default") {
  return identifyProduct(barcode, storeId, null);
}

async function searchProducts(query) { return productRepo.search(query); }
async function listProducts() { return productRepo.list(); }
async function getProduct(barcodeOrId) { return productRepo.get(barcodeOrId); }
async function saveProduct(product) { return productRepo.save(product); }
async function updateProduct(barcodeOrId, updates) { return productRepo.update(barcodeOrId, updates); }
async function deleteProduct(barcodeOrId) { return productRepo.remove(barcodeOrId); }

module.exports = { identifyProduct, findProduct, searchProducts, listProducts, getProduct, saveProduct, updateProduct, deleteProduct };
