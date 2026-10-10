const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const app = require("../src/app");
const productService = require("../src/services/product.service");
const catalogTestProduct = require("./fixtures/catalog-product.json");

let server;
let baseUrl;
let rawFetch;
let originalSalesData;
const salesFile = path.join(__dirname, "../data/sales.json");

test.before(async () => {
  // The API suite exercises the protected routes with a test-only identity.
  // Production middleware still requires a real, verified Firebase token.
  if (!getApps().length) initializeApp({ projectId: "expirymitra-test" });
  originalSalesData = await fs.readFile(salesFile, "utf8");
  await productService.saveProduct(catalogTestProduct);
  getAuth().verifyIdToken = async (token) => {
    if (token === "expirymitra-test-owner-token") {
      return { uid: "store_default", store_id: "store_default", role: "shopkeeper" };
    }
    if (token === "expirymitra-test-other-owner-token") {
      return { uid: "other_store", store_id: "other_store", role: "shopkeeper" };
    }
    throw new Error("Invalid test token");
  };
  rawFetch = global.fetch;
  global.fetch = (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : (input instanceof URL ? input.href : input.url), baseUrl || "http://127.0.0.1");
    if (url.hostname === "world.openfoodfacts.org") {
      return Promise.resolve(new Response(JSON.stringify({ status: 0, product: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    }
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
      const headers = new Headers(options.headers || (typeof input !== "string" ? input.headers : undefined));
      headers.set("Authorization", "Bearer expirymitra-test-owner-token");
      return rawFetch(input, { ...options, headers });
    }
    return rawFetch(input, options);
  };

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await productService.deleteProduct(catalogTestProduct.barcode);
  if (originalSalesData !== undefined) await fs.writeFile(salesFile, originalSalesData, "utf8");
});

test.after(async () => {
  if (rawFetch) global.fetch = rawFetch;
  if (server) {
    return new Promise((resolve) => server.close(resolve));
  }
});

/* ---------------- FRONTEND STATIC ASSETS ---------------- */

test("serves frontend index.html, styles.css, app.js, and vendor/zxing-browser.min.js", async () => {
  const [indexRes, cssRes, jsRes, zxingRes] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/styles.css`),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/vendor/zxing-browser.min.js`)
  ]);

  assert.equal(indexRes.status, 200);
  const html = await indexRes.text();
  assert.match(html, /ExpiryMitra/i);
  assert.match(html, /screen-splash/);
  assert.match(html, /screen-dashboard/);
  assert.match(html, /screen-record-sale/);
  assert.match(html, /zxing-browser\.min\.js/);
  assert.doesNotMatch(html, /id="tab-manual-entry"/);

  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get("content-type"), /css/);

  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get("content-type"), /javascript/);
  const js = await jsRes.text();
  assert.match(js, /showManualEntryForBarcode\(barcode, message\)/);

  assert.equal(zxingRes.status, 200);
  assert.match(zxingRes.headers.get("content-type"), /javascript/);
});

/* ---------------- HEALTH & SYSTEM STATUS ---------------- */

test("GET /api/health returns operational status and provider breakdown", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.service, "expirymitra");
  assert.ok(data.storage);
  assert.ok(data.ocr);
  assert.ok(data.ai);
});

test("business APIs reject requests without a verified session", async () => {
  const res = await rawFetch(`${baseUrl}/api/inventory`);
  assert.equal(res.status, 401);
});

/* ---------------- INVENTORY API ---------------- */

test("inventory summary and listing return accurate calculated status", async () => {
  const summaryRes = await fetch(`${baseUrl}/api/inventory/summary`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.ok(typeof summary.totalProducts === "number");
  assert.ok(typeof summary.safeCount === "number");
  assert.ok(typeof summary.expiringSoonCount === "number");

  const listRes = await fetch(`${baseUrl}/api/inventory`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.every((item) => item.status && typeof item.days_left === "number"));
});

test("creates manual inventory item and updates it", async () => {
  const testBarcode = `890555${Date.now().toString().slice(-7)}`;
  const createRes = await fetch(`${baseUrl}/api/inventory/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_name: "Fresh Paneer Block",
      brand: "FreshDairy",
      category: "Dairy",
      barcode: testBarcode,
      batch: "P11",
      expiry_date: "2029-01-01",
      quantity: 8,
      min_threshold: 4
    })
  });

  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.product_name, "Fresh Paneer Block");
  assert.equal(created.quantity, 8);

  const otherStoreRes = await rawFetch(`${baseUrl}/api/inventory/${created.id}`, {
    headers: { Authorization: "Bearer expirymitra-test-other-owner-token" }
  });
  assert.equal(otherStoreRes.status, 404);

  // Update item
  const updateRes = await fetch(`${baseUrl}/api/inventory/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 12 })
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.equal(updated.quantity, 12);

  // Clean up
  const delRes = await fetch(`${baseUrl}/api/inventory/${created.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
});

/* ---------------- PRODUCT CATALOG API ---------------- */

test("product barcode lookup finds product and returns 404 for missing", async () => {
  const foundRes = await fetch(`${baseUrl}/api/products/barcode/8901030700087`);
  assert.equal(foundRes.status, 200);
  const foundData = await foundRes.json();
  assert.equal(foundData.status, "found");
  assert.equal(foundData.success, true);
  assert.match(foundData.product.name, /Maggi/);
  assert.equal(foundData.product.barcode, "8901030700087");
  assert.ok(foundData.product.quantity !== undefined);

  const missingRes = await fetch(`${baseUrl}/api/products/barcode/3017620422003`);
  assert.equal(missingRes.status, 404);
  const missingData = await missingRes.json();
  assert.equal(missingData.success, false);
  assert.equal(missingData.status, "not_found");

  // POST /api/products/barcode
  const postFoundRes = await fetch(`${baseUrl}/api/products/barcode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: "8901030700087" })
  });
  assert.equal(postFoundRes.status, 200);
  const postData = await postFoundRes.json();
  assert.equal(postData.success, true);
  assert.match(postData.product.name, /Maggi/);

  // Invalid barcode returns 400
  const invalidRes = await fetch(`${baseUrl}/api/products/barcode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: "" })
  });
  assert.equal(invalidRes.status, 400);
});

test("parallel identify API returns verified catalog result or an explicit missing result", async () => {
  const foundRes = await fetch(`${baseUrl}/api/products/identify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: "8901030700087" })
  });
  assert.equal(foundRes.status, 200);
  const found = await foundRes.json();
  assert.equal(found.status, "found");
  assert.equal(found.product.source, "catalog");

  const missingRes = await fetch(`${baseUrl}/api/products/identify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: "3017620422003" })
  });
  assert.equal(missingRes.status, 404);
  assert.equal((await missingRes.json()).status, "not_found");
});

/* ---------------- SALES TRANSACTIONS API ---------------- */

test("sales API records sale transaction and reflects in sales summary", async () => {
  // First, create a temporary item to sell
  const invRes = await fetch(`${baseUrl}/api/inventory/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_name: "API Test Drink",
      barcode: "8904443332211",
      expiry_date: "2028-12-31",
      quantity: 15
    })
  });
  const invItem = await invRes.json();

  // Record a sale
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inventory_id: invItem.id,
      quantity_sold: 4,
      unit_price: 35
    })
  });

  assert.equal(saleRes.status, 201);
  const saleData = await saleRes.json();
  assert.equal(saleData.status, "success");
  assert.equal(saleData.remainingStock, 11);
  assert.equal(saleData.sale.total_amount, 140);

  // Sales summary check
  const summaryRes = await fetch(`${baseUrl}/api/sales/summary?range=all`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.ok(summary.totalSales >= 1);
  assert.ok(summary.totalRevenue >= 140);

  // Clean up
  await fetch(`${baseUrl}/api/inventory/${invItem.id}`, { method: "DELETE" });
});

/* ---------------- STORE PROFILE API ---------------- */

test("store profile GET and PUT endpoints work properly", async () => {
  const getRes = await fetch(`${baseUrl}/api/store`);
  assert.equal(getRes.status, 200);
  const store = await getRes.json();
  assert.ok(store.store_name);

  const putRes = await fetch(`${baseUrl}/api/store`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9123456780" })
  });
  assert.equal(putRes.status, 200);
  const updated = await putRes.json();
  assert.equal(updated.phone, "9123456780");

  // Restore
  await fetch(`${baseUrl}/api/store`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9876543210" })
  });
});

test("protected date-label API includes structured GS1 dates for shopkeeper review", async () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorOcrMode = process.env.OCR_MODE;
  const priorGeminiKey = process.env.GEMINI_API_KEY;
  process.env.NODE_ENV = "test";
  process.env.OCR_MODE = "mock";
  delete process.env.GEMINI_API_KEY;
  try {
    const response = await fetch(`${baseUrl}/api/scan/dates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode: "]C1010301762042200317270630", image: "data:image/jpeg;base64,test" })
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    const gs1Expiry = data.candidates.find((candidate) => candidate.date_type === "expiry_date" && candidate.source === "gs1_barcode");
    assert.equal(gs1Expiry.normalized_date, "2027-06-30");
    assert.equal(data.requires_confirmation, true);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorOcrMode === undefined) delete process.env.OCR_MODE; else process.env.OCR_MODE = priorOcrMode;
    if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorGeminiKey;
  }
});
require("./helpers/preserve-data");
