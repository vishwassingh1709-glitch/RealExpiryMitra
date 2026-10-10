const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");

process.env.STORAGE_PROVIDER = "json";
process.env.OPEN_FOOD_FACTS_TIMEOUT_MS = "35";
process.env.PRODUCT_LOOKUP_TIMEOUT_MS = "80";
process.env.PRODUCT_IDENTIFICATION_TIMEOUT_MS = "80";
process.env.GEMINI_API_KEY = "test-only";

const productService = require("../src/services/product.service");
const productRepo = require("../src/repositories/product.repository");
const inventoryRepo = require("../src/repositories/inventory.repository");
const aiService = require("../src/services/ai.service");

function ean13(seed) {
  const body = String(seed).replace(/\D/g, "").padStart(12, "5").slice(-12);
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return body + String((10 - (sum % 10)) % 10);
}

function setup({ catalog = null, inventory = null, fetchImpl, gemini = async () => null }) {
  const oldGet = productRepo.get;
  const oldInventoryGet = inventoryRepo.getByBarcode;
  const oldFetch = global.fetch;
  const oldGemini = aiService.identifyProductFromImage;
  let reads = 0;
  let fetches = 0;
  productRepo.get = async (barcode) => { reads += 1; return catalog?.barcode === barcode ? catalog : null; };
  inventoryRepo.getByBarcode = async (barcode) => inventory?.barcode === barcode ? inventory : null;
  global.fetch = async (...args) => { fetches += 1; return fetchImpl(...args); };
  aiService.identifyProductFromImage = gemini;
  return {
    reads: () => reads,
    fetches: () => fetches,
    restore() {
      productRepo.get = oldGet;
      inventoryRepo.getByBarcode = oldInventoryGet;
      global.fetch = oldFetch;
      aiService.identifyProductFromImage = oldGemini;
    }
  };
}

const image = "data:image/jpeg;base64,ZmFrZQ==";
const noOffProduct = () => new Response(JSON.stringify({ status: 0, product: null }), { status: 200 });

test("verified Firestore-catalogue identity wins over a simultaneous OFF response", async () => {
  const barcode = ean13("40063813339");
  const h = setup({
    catalog: { barcode, name: "Verified local product", brand: "Local brand", source: "manual", verification_status: "confirmed" },
    fetchImpl: async () => new Response(JSON.stringify({ status: 0, product: null }), { status: 200 })
  });
  try {
    const result = await productService.identifyProduct(barcode, "test_store");
    assert.equal(result.status, "found");
    assert.equal(result.product.source, "catalog");
    assert.equal(result.product.name, "Verified local product");
    assert.equal(h.fetches(), 1, "Open Food Facts lookup starts alongside the local catalogue query");
  } finally { h.restore(); }
});

test("Open Food Facts is used only for a response carrying the matching barcode", async () => {
  const barcode = ean13("59012341234");
  const h = setup({ fetchImpl: async () => new Response(JSON.stringify({
    status: "success",
    product: { code: barcode, product_name: "OFF match", brands: "Known brand", categories: "Food" }
  }), { status: 200 }) });
  try {
    const result = await productService.identifyProduct(barcode, "test_store");
    assert.equal(result.status, "found");
    assert.equal(result.product.source, "open_food_facts");
    assert.equal(result.product.verification_status, "unverified");
  } finally { h.restore(); }
});

test("Gemini uses the same package photo as a labeled candidate only after catalogue lookups miss", async () => {
  const barcode = ean13("59012340001");
  const h = setup({
    fetchImpl: async () => noOffProduct(),
    gemini: async (_image, requestedBarcode) => ({
      barcode: requestedBarcode, name: "Visible package product", brand: "Visible brand",
      category: "Snacks", packaging_evidence: "Brand and product title readable on the front",
      source: "gemini_candidate", verification_status: "unverified"
    })
  });
  try {
    const result = await productService.identifyProduct(barcode, "gemini_candidate_store", image);
    assert.equal(result.status, "found");
    assert.equal(result.product.source, "gemini_candidate");
    assert.equal(result.product.verification_status, "unverified");
  } finally { h.restore(); }
});

test("unknown code and timed-out sources do not produce fabricated matches", async () => {
  const barcode = ean13("59012349876");
  const missing = setup({ fetchImpl: async () => noOffProduct() });
  try { assert.equal((await productService.identifyProduct(barcode, "test_store")).status, "not_found"); }
  finally { missing.restore(); }

  const timed = setup({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }) });
  try { assert.equal((await productService.identifyProduct(barcode, "timeout_store")).status, "unavailable"); }
  finally { timed.restore(); }
});

test("a photo candidate waits for catalogue lookup and conflicting identity is surfaced", async () => {
  const barcode = ean13("59012340999");
  const h = setup({
    fetchImpl: async () => noOffProduct(),
    gemini: async () => ({ barcode, name: "Britannia Biscuits", brand: "Britannia", category: "Snacks", source: "gemini_candidate", verification_status: "unverified" })
  });
  const oldGet = productRepo.get;
  productRepo.get = async (value) => { await new Promise((resolve) => setTimeout(resolve, 20)); return value === barcode ? { barcode, name: "Amul Butter", brand: "Amul", source: "manual", verification_status: "confirmed" } : null; };
  try {
    const result = await productService.identifyProduct(barcode, "conflict_store", image);
    assert.equal(result.status, "conflict");
    assert.equal(result.product.name, "Amul Butter");
    assert.equal(result.candidate.name, "Britannia Biscuits");
  } finally { productRepo.get = oldGet; h.restore(); }
});

test("Gemini failures fall back, and a late Gemini result is cancelled/ignored after a verified hit", async () => {
  const failedBarcode = ean13("59012990000");
  const failed = setup({ fetchImpl: async () => noOffProduct(), gemini: async () => { throw new Error("Gemini offline"); } });
  try { assert.equal((await productService.identifyProduct(failedBarcode, "gemini_failure_store", image)).status, "not_found"); }
  finally { failed.restore(); }

  const barcode = ean13("59012990001");
  let receivedSignal;
  let releaseLate;
  const late = setup({
    catalog: { barcode, name: "Verified fast result", source: "manual", verification_status: "confirmed" },
    fetchImpl: async () => noOffProduct(),
    gemini: (_image, _barcode, { signal }) => {
      receivedSignal = signal;
      return new Promise((resolve) => { releaseLate = resolve; });
    }
  });
  inventoryRepo.getByBarcode = () => new Promise(() => {});
  try {
    const result = await Promise.race([
      productService.identifyProduct(barcode, "late_store", image),
      new Promise((_, reject) => setTimeout(() => reject(new Error("verified catalogue result waited on inventory/Gemini")), 25))
    ]);
    assert.equal(result.product.name, "Verified fast result");
    assert.equal(receivedSignal.aborted, true);
    releaseLate({ name: "Unrelated late candidate", source: "gemini_candidate" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(result.product.name, "Verified fast result");
  } finally { late.restore(); }
});

test("identical simultaneous identification requests share the same work", async () => {
  const barcode = ean13("59019998888");
  let release;
  const h = setup({ fetchImpl: () => new Promise((resolve) => { release = () => resolve(noOffProduct()); }) });
  try {
    const first = productService.identifyProduct(barcode, "dedupe_store");
    const second = productService.identifyProduct(barcode, "dedupe_store");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.reads(), 1);
    assert.equal(h.fetches(), 1);
    release();
    assert.deepEqual(await first, await second);
  } finally { h.restore(); }
});
