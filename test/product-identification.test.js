const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");

process.env.STORAGE_PROVIDER = "json";
process.env.OPEN_FOOD_FACTS_TIMEOUT_MS = "35";
process.env.PRODUCT_LOOKUP_TIMEOUT_MS = "80";
process.env.PRODUCT_IDENTIFICATION_TIMEOUT_MS = "80";
process.env.GEMINI_API_KEY = "test-only";
delete process.env.GROQ_API_KEY;

const productService = require("../src/services/product.service");
const productRepo = require("../src/repositories/product.repository");
const inventoryRepo = require("../src/repositories/inventory.repository");
const aiService = require("../src/services/ai.service");
const groqProductSearch = require("../src/services/groq-product-search.service");

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

test("a verified catalogue match wins without starting the lower-priority Gemini fallback", async () => {
  const barcode = ean13("59012340999");
  let geminiCalls = 0;
  const h = setup({
    fetchImpl: async () => noOffProduct(),
    gemini: async () => { geminiCalls += 1; return null; }
  });
  const oldGet = productRepo.get;
  productRepo.get = async (value) => { await new Promise((resolve) => setTimeout(resolve, 20)); return value === barcode ? { barcode, name: "Amul Butter", brand: "Amul", source: "manual", verification_status: "confirmed" } : null; };
  try {
    const result = await productService.identifyProduct(barcode, "conflict_store", image);
    assert.equal(result.status, "found");
    assert.equal(result.product.name, "Amul Butter");
    assert.equal(geminiCalls, 0);
  } finally { productRepo.get = oldGet; h.restore(); }
});

test("Gemini failures fall back, and a verified catalogue hit avoids unnecessary Gemini work", async () => {
  const failedBarcode = ean13("59012990000");
  const failed = setup({ fetchImpl: async () => noOffProduct(), gemini: async () => { throw new Error("Gemini offline"); } });
  try { assert.equal((await productService.identifyProduct(failedBarcode, "gemini_failure_store", image)).status, "not_found"); }
  finally { failed.restore(); }

  const barcode = ean13("59012990001");
  let geminiCalls = 0;
  const late = setup({
    catalog: { barcode, name: "Verified fast result", source: "manual", verification_status: "confirmed" },
    fetchImpl: async () => noOffProduct(),
    gemini: async () => { geminiCalls += 1; return null; }
  });
  inventoryRepo.getByBarcode = () => new Promise(() => {});
  try {
    const result = await Promise.race([
      productService.identifyProduct(barcode, "late_store", image),
      new Promise((_, reject) => setTimeout(() => reject(new Error("verified catalogue result waited on inventory/Gemini")), 25))
    ]);
    assert.equal(result.product.name, "Verified fast result");
    assert.equal(geminiCalls, 0);
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

function groqCandidateText(barcode) {
  return [
    "RESULT: MATCH",
    "PRODUCT NAME: Fixture packaged tea 250 g",
    "BRAND: Fixture brand",
    "PACKAGE SIZE: 250 g",
    `EXACT BARCODE: ${barcode}`,
    "EXACT MATCH: YES",
    `EVIDENCE: Manufacturer product page explicitly lists barcode ${barcode} for Fixture packaged tea 250 g.`,
    "SOURCE URLS: https://manufacturer.example/products/tea"
  ].join("\n");
}

test("Groq Browser Search only returns an unverified candidate with exact barcode evidence and source URLs", async () => {
  const barcode = `0${ean13("59012345678")}`;
  const priorKey = process.env.GROQ_API_KEY;
  const priorModel = process.env.GROQ_BROWSER_SEARCH_MODEL;
  process.env.GROQ_API_KEY = "test-key-never-logged";
  delete process.env.GROQ_BROWSER_SEARCH_MODEL;
  try {
    const result = await groqProductSearch.lookupBarcodeOnWeb(barcode, {
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
        assert.equal(options.headers.Authorization, "Bearer test-key-never-logged");
        const request = JSON.parse(options.body);
        assert.equal(request.model, "openai/gpt-oss-20b");
        assert.deepEqual(request.tools, [{ type: "browser_search" }]);
        assert.equal(request.tool_choice, "required");
        assert.match(request.messages[0].content, new RegExp(barcode));
        return new Response(JSON.stringify({ choices: [{ message: { content: groqCandidateText(barcode) } }] }), { status: 200 });
      }
    });
    assert.equal(result.status, "found");
    assert.equal(result.product.barcode, barcode, "leading zero is preserved");
    assert.equal(result.product.verification_status, "unverified");
    assert.equal(result.product.exact_barcode_match, true);
    assert.deepEqual(result.product.source_urls, ["https://manufacturer.example/products/tea"]);
  } finally {
    if (priorKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env.GROQ_BROWSER_SEARCH_MODEL; else process.env.GROQ_BROWSER_SEARCH_MODEL = priorModel;
  }
});

test("Groq falls through on missing key, unsupported model, malformed evidence, and unknown barcode", async () => {
  const barcode = ean13("59012341235");
  const priorKey = process.env.GROQ_API_KEY;
  const priorModel = process.env.GROQ_BROWSER_SEARCH_MODEL;
  const priorTimeout = process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS;
  try {
    delete process.env.GROQ_API_KEY;
    assert.deepEqual(await groqProductSearch.lookupBarcodeOnWeb(barcode, { fetchImpl: async () => { throw new Error("must not call"); } }), { status: "not_configured" });

    process.env.GROQ_API_KEY = "test-key";
    process.env.GROQ_BROWSER_SEARCH_MODEL = "unsupported/search-model";
    assert.deepEqual(await groqProductSearch.lookupBarcodeOnWeb(barcode, { fetchImpl: async () => { throw new Error("must not call"); } }), { status: "unsupported_model" });

    process.env.GROQ_BROWSER_SEARCH_MODEL = "openai/gpt-oss-20b";
    const uncertain = groqProductSearch.parseBrowserSearchResponse({ choices: [{ message: { content: "RESULT: UNCERTAIN\nPRODUCT NAME: Similar tea\nEVIDENCE: Similar product only\nSOURCE URLS: https://retailer.example/item" } }] }, barcode);
    assert.deepEqual(uncertain, { status: "not_found" }, "a similar result without an explicit exact barcode is rejected");
    const wrongBarcode = groqProductSearch.parseBrowserSearchResponse({ choices: [{ message: { content: groqCandidateText(ean13("59012349999")) } }] }, barcode);
    assert.deepEqual(wrongBarcode, { status: "not_found" }, "evidence for a different barcode is rejected");
    const malformed = await groqProductSearch.lookupBarcodeOnWeb(ean13("59012341236"), {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "A product may exist, but no source details were returned." } }] }), { status: 200 })
    });
    assert.deepEqual(malformed, { status: "malformed_response" });

    const h = setup({ fetchImpl: async (url, options) => {
      if (String(url).includes("openfoodfacts")) return noOffProduct();
      return new Response(JSON.stringify({ choices: [{ message: { content: "RESULT: NOT_FOUND" } }] }), { status: 200 });
    } });
    try {
      const result = await productService.identifyProduct(barcode, "groq_unknown_store");
      assert.equal(result.status, "not_found");
    } finally { h.restore(); }
  } finally {
    if (priorKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env.GROQ_BROWSER_SEARCH_MODEL; else process.env.GROQ_BROWSER_SEARCH_MODEL = priorModel;
    if (priorTimeout === undefined) delete process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS; else process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS = priorTimeout;
  }
});

test("Groq timeout and rate limits are bounded and classified without exposing credentials", async () => {
  const barcode = ean13("59012345670");
  const priorKey = process.env.GROQ_API_KEY;
  const priorTimeout = process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS;
  process.env.GROQ_API_KEY = "test-key";
  process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS = "10";
  try {
    const timeout = await groqProductSearch.lookupBarcodeOnWeb(barcode, {
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))
    });
    assert.deepEqual(timeout, { status: "timeout" });
    const limited = await groqProductSearch.lookupBarcodeOnWeb(ean13("59012345671"), {
      fetchImpl: async () => new Response("{}", { status: 429 })
    });
    assert.deepEqual(limited, { status: "rate_limited" });
  } finally {
    if (priorKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorKey;
    if (priorTimeout === undefined) delete process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS; else process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS = priorTimeout;
  }
});

test("Groq candidate is attempted after OFF miss and before Gemini photo fallback", async () => {
  const barcode = ean13("59012345002");
  const priorKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "test-key";
  let geminiCalls = 0;
  const h = setup({
    fetchImpl: async (url) => String(url).includes("openfoodfacts")
      ? noOffProduct()
      : new Response(JSON.stringify({ choices: [{ message: { content: groqCandidateText(barcode) } }] }), { status: 200 }),
    gemini: async () => { geminiCalls += 1; return null; }
  });
  try {
    const result = await productService.identifyProduct(barcode, "groq_order_store", image);
    assert.equal(result.status, "found");
    assert.equal(result.product.source, "groq_browser_search_candidate");
    assert.equal(result.product.verification_status, "unverified");
    assert.equal(geminiCalls, 0, "Gemini is reserved for when Groq cannot produce an evidence-backed candidate");
  } finally {
    h.restore();
    if (priorKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorKey;
  }
});
