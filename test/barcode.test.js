const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");
const barcode = require("../src/utils/barcode");

test("normalizes values and validates retail GTIN check digits", () => {
  assert.equal(barcode.normalizeBarcode("  3017620422003  "), "3017620422003");
  assert.equal(barcode.normalizeBarcode("\u0000"), "");
  assert.equal(barcode.normalizeBarcode("]C10103017620422003\u001d17123456"), "]C10103017620422003\u001d17123456");
  assert.equal(barcode.hasValidGs1CheckDigit("3017620422003"), true);
  assert.equal(barcode.hasValidGs1CheckDigit("3017620422004"), false);
  assert.equal(barcode.isRetailGtin("3017620422003"), true);
  assert.equal(barcode.isRetailGtin("3017620422004"), false);
});

test("matches UPC-A and its zero-prefixed EAN-13 representation", () => {
  assert.deepEqual(barcode.barcodeCandidates("036000291452"), ["036000291452", "0036000291452"]);
  assert.equal(barcode.canonicalBarcode("036000291452"), "0036000291452");
});

test("extracts a verified GTIN-14 from GS1 element strings without confusing plain retail codes", () => {
  assert.equal(barcode.extractGs1Gtin("]C1010301762042200317270630"), "03017620422003");
  assert.equal(barcode.extractGs1Gtin("(01)03017620422003(17)270630"), "03017620422003");
  assert.equal(barcode.extractGs1Gtin("https://id.gs1.org/01/03017620422003/17/270630"), "03017620422003");
  assert.equal(barcode.extractGs1Gtin("]C1010950110153001717270630"), null);
  assert.deepEqual(barcode.barcodeCandidates("03017620422003"), ["03017620422003", "3017620422003"]);
});

test("Open Food Facts fixture is a suggestion, never a lookup-time catalog write", async () => {
  const productService = require("../src/services/product.service");
  const productRepo = require("../src/repositories/product.repository");
  const previousProvider = process.env.STORAGE_PROVIDER;
  const previousFetch = global.fetch;
  const previousSave = productRepo.save;
  let saves = 0;
  process.env.STORAGE_PROVIDER = "json";
  productRepo.save = async () => { saves += 1; };
  global.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v3/product/4006381333931");
    assert.equal(url.searchParams.get("cc"), "in");
    return new Response(JSON.stringify({
      status: "success",
      product: {
        code: "4006381333931",
        product_name: "Test-only product fixture",
        brands: "Fixture brand",
        categories: "Food",
        image_front_url: "https://images.example.test/product.jpg"
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await productService.findProduct("4006381333931", "test_store");
    assert.equal(result.status, "found");
    assert.equal(result.product.source, "open_food_facts");
    assert.equal(result.product.verification_status, "unverified");
    assert.equal(result.product.image_url, "https://images.example.test/product.jpg");
    assert.equal(saves, 0);
  } finally {
    productRepo.save = previousSave;
    global.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = previousProvider;
  }
});

test("malformed GTINs and OFF outages stay distinct from real matches", async () => {
  const productService = require("../src/services/product.service");
  const previousProvider = process.env.STORAGE_PROVIDER;
  const previousFetch = global.fetch;
  process.env.STORAGE_PROVIDER = "json";
  try {
    assert.equal((await productService.findProduct("4006381333932", "test_store")).status, "invalid");
    global.fetch = async () => new Response("rate limited", { status: 429 });
    assert.equal((await productService.findProduct("4006381333931", "test_store")).status, "unavailable");
    global.fetch = async () => new Response(JSON.stringify({ status: "failure", product: null }), { status: 200 });
    assert.equal((await productService.findProduct("4006381333931", "test_store")).status, "not_found");
    global.fetch = async () => { const error = new Error("offline"); error.name = "AbortError"; throw error; };
    assert.equal((await productService.findProduct("4006381333931", "test_store")).status, "unavailable");
  } finally {
    global.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = previousProvider;
  }
});

test("catalogue confirmation only follows a successful inventory save", async () => {
  const inventoryService = require("../src/services/inventory.service");
  const inventoryRepo = require("../src/repositories/inventory.repository");
  const productRepo = require("../src/repositories/product.repository");
  const oldInventorySave = inventoryRepo.save;
  const oldProductSave = productRepo.save;
  const calls = [];
  inventoryRepo.save = async (item) => { calls.push("inventory"); return item; };
  productRepo.save = async (product) => { calls.push("catalog"); return product; };
  try {
    await inventoryService.create({ barcode: "4006381333931", product_name: "Shopkeeper reviewed", expiry_date: "2027-01-01", source: "barcode" }, "test_store");
    assert.deepEqual(calls, ["inventory", "catalog"]);
    calls.length = 0;
    inventoryRepo.save = async () => { calls.push("inventory"); throw new Error("inventory write failed"); };
    await assert.rejects(() => inventoryService.create({ barcode: "4006381333931", product_name: "Shopkeeper reviewed", expiry_date: "2027-01-01" }, "test_store"));
    assert.deepEqual(calls, ["inventory"]);
  } finally {
    inventoryRepo.save = oldInventorySave;
    productRepo.save = oldProductSave;
  }
});
