const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const { validate, validDate } = require("../src/services/validation.service");
const { interpretExpiry, interpretExpiryDeterministic } = require("../src/services/ai.service");
const { extractText, normalizeOcrText } = require("../src/services/ocr.service");
const { parseDate, addMonthsToDate, addDaysToDate } = require("../src/utils/date.parser");
const inventoryService = require("../src/services/inventory.service");
const productService = require("../src/services/product.service");
const scanHistoryService = require("../src/services/scan-history.service");
const categoryRepo = require("../src/repositories/category.repository");
const { processScan } = require("../src/services/scan.service");
const { getFirestoreStatus } = require("../src/repositories/firestore");

const inventoryFile = path.join(__dirname, "../data/inventory.json");

/* ---------------- DATE PARSER TESTS ---------------- */

test("parses standard DD/MM/YYYY and DD-MM-YYYY formats", () => {
  assert.equal(parseDate("15/08/2027"), "2027-08-15");
  assert.equal(parseDate("01-06-2026"), "2026-06-01");
});

test("parses textual month formats like 20 AUG 2027 and AUG 2027", () => {
  assert.equal(parseDate("20 AUG 2027"), "2027-08-20");
  assert.equal(parseDate("AUG 2027", { isExpiry: true }), "2027-08-31");
});

test("parses MM/YYYY format with correct end-of-month for expiry", () => {
  assert.equal(parseDate("12/2027", { isExpiry: true }), "2027-12-31");
  assert.equal(parseDate("02/2024", { isExpiry: true }), "2024-02-29"); // Leap year
  assert.equal(parseDate("01/2026", { isExpiry: false }), "2026-01-01"); // Manufacturing
});

test("calculates relative expiry: 6 months from manufacturing", () => {
  const mfg = "2026-01-15";
  const expiry = addMonthsToDate(mfg, 6);
  assert.equal(expiry, "2026-07-15");
});

test("rejects invalid or impossible dates", () => {
  assert.equal(parseDate("32/01/2026"), null);
  assert.equal(parseDate("15/13/2026"), null);
  assert.equal(parseDate("invalid-string"), null);
});

/* ---------------- VALIDATION SERVICE TESTS ---------------- */

test("validates a confident expiry result", () => {
  const result = validate({
    confidence: 0.94,
    mfg_date: "2024-06-12",
    expiry_date: "2026-06-11"
  });
  assert.equal(result.accepted, true);
});

test("rejects low-confidence results below threshold", () => {
  const result = validate({
    confidence: 0.5,
    expiry_date: "2026-06-11"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "low_confidence");
});

test("rejects expiry date earlier than manufacturing date", () => {
  const result = validate({
    confidence: 0.95,
    mfg_date: "2026-06-12",
    expiry_date: "2026-06-11"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid");
});

test("rejects invalid date format strings", () => {
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2026/05/10"), false);
  assert.equal(validDate("2026-05-10"), true);
});

/* ---------------- AI / DETERMINISTIC PARSER TESTS ---------------- */

test("deterministic parser extracts MFG, EXP, and BATCH correctly", async () => {
  const result = await interpretExpiry(
    "MFG 12/06/2024 EXP 11/06/2026 BATCH A24B7"
  );
  assert.equal(result.mfg_date, "2024-06-12");
  assert.equal(result.expiry_date, "2026-06-11");
  assert.equal(result.batch, "A24B7");
  assert.equal(result.confidence, 0.94);
});

test("distinguishes manufacturing date from expiry date on multi-line label", async () => {
  const raw = "PKD: 01/01/2025\nUSE BY: 15/08/2027\nLOT: B99X";
  const result = interpretExpiryDeterministic(raw);
  assert.equal(result.mfg_date, "2025-01-01");
  assert.equal(result.expiry_date, "2027-08-15");
  assert.equal(result.batch, "B99X");
});

test("handles relative label: BEST BEFORE 6 MONTHS FROM MFG", async () => {
  const raw = "MFG: 10/01/2026\nBEST BEFORE 6 MONTHS FROM MFG\nBN: 1044";
  const result = interpretExpiryDeterministic(raw);
  assert.equal(result.mfg_date, "2026-01-10");
  assert.equal(result.expiry_date, "2026-07-10");
});

test("flags ambiguity when no expiry date is found", async () => {
  const raw = "SOME RANDOM TEXT WITHOUT DATES";
  const result = interpretExpiryDeterministic(raw);
  assert.equal(result.expiry_date, null);
  assert.ok(result.confidence < 0.5);
});

/* ---------------- OCR SERVICE TESTS ---------------- */

test("normalizes noisy OCR text without corrupting dates", () => {
  const noisy = "E X P : \n 15 / 08 / 2027 \n  M F G : 01 / 01 / 2026";
  const cleaned = normalizeOcrText(noisy);
  assert.match(cleaned, /EXP: 15\/08\/2027/);
  assert.match(cleaned, /MFG: 01\/01\/2026/);
});

test("mock OCR returns deterministic practice text for test payload", async () => {
  const result = await extractText("data:image/jpeg;base64,test");
  assert.match(result.rawText, /MFG 12\/06\/2024/);
  assert.equal(result.confidence, 0.96);
});

test("rejects invalid or empty image payloads", async () => {
  const result = await extractText("");
  assert.equal(result.source, "invalid_image");
  assert.equal(result.rawText, "");
});

/* ---------------- INVENTORY CRUD & STATUS TESTS ---------------- */

test("inventory status computes safe, expiring_soon, and expired properly", () => {
  assert.equal(inventoryService.statusFor("2000-01-01").status, "expired");
  assert.equal(inventoryService.statusFor("2099-01-01").status, "safe");
});

test("inventory CRUD operations persist and compute status correctly", async () => {
  const testId = `inv_test_${Date.now()}`;
  const created = await inventoryService.create({
    id: testId,
    barcode: "8901234567890",
    product_name: "Test Milk",
    brand: "Amul",
    category: "Dairy",
    expiry_date: "2099-12-31",
    quantity: 2
  });

  assert.equal(created.id, testId);
  assert.equal(created.quantity, 2);

  // Read
  const fetched = await inventoryService.get(testId);
  assert.equal(fetched.product_name, "Test Milk");
  assert.equal(fetched.status, "safe");

  // Update
  const updated = await inventoryService.update(testId, { quantity: 5, brand: "Amul Gold" });
  assert.equal(updated.quantity, 5);
  assert.equal(updated.brand, "Amul Gold");

  // Summary
  const summary = await inventoryService.getSummary();
  assert.ok(summary.totalProducts >= 1);
  assert.ok(summary.safeCount >= 1);

  // Delete
  const deleted = await inventoryService.remove(testId);
  assert.equal(deleted, true);

  const missing = await inventoryService.get(testId);
  assert.equal(missing, null);
});

/* ---------------- PRODUCT REPOSITORY & CATEGORIES ---------------- */

test("lists default food and grocery categories", async () => {
  const categories = await categoryRepo.listCategories();
  assert.ok(Array.isArray(categories));
  assert.ok(categories.some((c) => c.id === "dairy"));
  assert.ok(categories.some((c) => c.id === "packaged"));
});

test("product service finds local known product", async () => {
  const res = await productService.findProduct("8901030700087");
  assert.equal(res.status, "found");
  assert.equal(res.product.name, "Maggi 2-Minute Noodles");
});

/* ---------------- SCAN ORCHESTRATION & HISTORY ---------------- */

test("scan flow returns candidate details without saving until confirmed", async () => {
  const result = await processScan({
    barcode: "8901030700087",
    image: "data:image/jpeg;base64,test"
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "confident");
  assert.equal(result.body.product.name, "Maggi 2-Minute Noodles");
  assert.ok(result.body.expiry.parsed_expiry_date);
  assert.equal(result.body.needs_confirmation, true);
  assert.ok(result.body.record_id);
});

test("scan history records audit events", async () => {
  const history = await scanHistoryService.getHistory(5);
  assert.ok(Array.isArray(history));
  assert.ok(history.length >= 1);
  assert.equal(history[0].barcode, "8901030700087");
});

test("database status check accurately reports configured state", () => {
  const status = getFirestoreStatus();
  assert.equal(typeof status.configured, "boolean");
  assert.equal(typeof status.connected, "boolean");
});
