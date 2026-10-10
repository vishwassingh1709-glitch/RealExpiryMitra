const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");
const { parseGs1Barcode } = require("../src/utils/gs1");
const { parseDateLabelText, normalizeGeminiFields } = require("../src/utils/date-label.parser");
const ocrService = require("../src/services/ocr.service");
const aiService = require("../src/services/ai.service");
const inventoryRepository = require("../src/repositories/inventory.repository");

const oldOcr = ocrService.extractText;
const oldGemini = aiService.identifyDatesFromImage;
let mockOcr = async () => ({ rawText: "", normalizedText: "", source: "test" });
let mockGemini = async () => ({});
ocrService.extractText = (...args) => mockOcr(...args);
aiService.identifyDatesFromImage = (...args) => mockGemini(...args);
delete require.cache[require.resolve("../src/services/date-extraction.service")];
const { extractDates, mergeCandidates, FALLBACK_MESSAGE } = require("../src/services/date-extraction.service");

test.after(() => {
  ocrService.extractText = oldOcr;
  aiService.identifyDatesFromImage = oldGemini;
});

test("GS1 structured dates and batch fields are parsed, including day 00 month precision", () => {
  const result = parseGs1Barcode("]C10103017620422003172706301124010110LOT-9\u001d");
  assert.equal(result.find((item) => item.date_type === "expiry_date")?.normalized_date, "2027-06-30");
  assert.equal(result.find((item) => item.date_type === "manufacturing_date")?.normalized_date, "2024-01-01");
  assert.equal(result.find((item) => item.date_type === "batch_number")?.raw_value, "LOT-9");
  const monthOnly = parseGs1Barcode("(01)03017620422003(17)270200")[0];
  assert.equal(monthOnly.normalized_date, "2027-02-28");
  assert.equal(monthOnly.precision, "month");
  assert.equal(monthOnly.date_convention, "gs1_day_00_end_of_month");
  assert.equal(parseGs1Barcode("https://id.gs1.org/01/03017620422003/17/270630")[0].normalized_date, "2027-06-30");
  assert.equal(parseGs1Barcode("(17)160200")[0].normalized_date, "2016-02-29");
});

test("ordinary EAN data is never treated as a date", () => {
  assert.deepEqual(parseGs1Barcode("8901234567890"), []);
});

test("date label parser distinguishes MFG, EXP, best-before, batch and retained relative wording", () => {
  const result = parseDateLabelText("MFG: 13/05/2026\nEXP: 14/06/2027\nBEST BEFORE: 08/2027\nBATCH NO: AB123\nBest before 6 months from MFG");
  assert.equal(result.candidates.find((item) => item.date_type === "manufacturing_date")?.normalized_date, "2026-05-13");
  assert.equal(result.candidates.find((item) => item.date_type === "expiry_date")?.normalized_date, "2027-06-14");
  assert.equal(result.candidates.find((item) => item.date_type === "best_before_date")?.normalized_date, "2027-08");
  assert.equal(result.candidates.find((item) => item.date_type === "batch_number")?.raw_value, "AB123");
  assert.equal(result.candidates.find((item) => item.date_type === "best_before_duration")?.derived, false);
});

test("ambiguous numeric dates and invalid dates are surfaced without a fabricated normalized day", () => {
  const ambiguous = parseDateLabelText("EXP 05/06/2027").candidates[0];
  assert.equal(ambiguous.normalized_date, null);
  assert.equal(ambiguous.uncertain, true);
  const invalid = parseDateLabelText("EXP 31/02/2027").candidates[0];
  assert.equal(invalid.normalized_date, null);
  assert.equal(invalid.uncertain, true);
});

test("a printed relative shelf-life is calculated only from an explicit exact start date and stays marked derived", () => {
  const readable = parseDateLabelText("MFG 15/01/2026\nBest before 6 months from MFG");
  const derived = readable.candidates.find((item) => item.date_type === "best_before_date");
  assert.equal(derived.normalized_date, "2026-07-15");
  assert.equal(derived.derived, true);
  assert.equal(derived.uncertain, true);
  const ambiguous = parseDateLabelText("MFG 05/06/2026\nBest before 6 months from MFG");
  assert.equal(ambiguous.candidates.some((item) => item.derived), false);
});

test("OCR label results remain review candidates and never auto-confirm a record", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldOcrMode = process.env.OCR_MODE;
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  process.env.NODE_ENV = "test";
  process.env.OCR_MODE = "";
  delete process.env.GEMINI_API_KEY;
  mockOcr = async () => ({ rawText: "MFD 13/05/2026 EXP 14/06/2027 LOT AB123", normalizedText: "MFD 13/05/2026 EXP 14/06/2027 LOT AB123", source: "tesseract" });
  try {
    const result = await extractDates({ barcode: "8901234567890", image: "data:image/jpeg;base64,photo" });
    assert.equal(result.status, "review_required");
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.candidates.find((item) => item.date_type === "expiry_date")?.normalized_date, "2027-06-14");
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldOcrMode === undefined) delete process.env.OCR_MODE; else process.env.OCR_MODE = oldOcrMode;
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
  }
});

test("ambiguous OCR prompts Gemini; Gemini values remain suggestions and disagreements are flagged", async () => {
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  mockOcr = async () => ({ rawText: "EXP 13/05/2027\nEXP 14/05/2027", normalizedText: "EXP 13/05/2027\nEXP 14/05/2027", source: "tesseract" });
  mockGemini = async () => ({ expiry_date: "2027-05-15", raw_visible_text: "EXP 13/05/2027 or 14/05/2027", uncertain_fields: [] });
  try {
    const result = await extractDates({ image: "data:image/jpeg;base64,photo" });
    const candidates = result.candidates.filter((item) => item.date_type === "expiry_date");
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((item) => item.conflict));
    assert.equal(candidates.find((item) => item.source === "gemini_image")?.uncertain, true);
  } finally {
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
  }
});

test("PaddleOCR bridge forwards image and service token, preserving returned text confidence", async () => {
  const oldUrl = process.env.PADDLE_OCR_URL;
  const oldToken = process.env.PADDLE_OCR_TOKEN;
  const oldFetch = global.fetch;
  process.env.PADDLE_OCR_URL = "http://ocr.internal/ocr";
  process.env.PADDLE_OCR_TOKEN = "unit-test-token";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ lines: [{ text: "EXP 08/2027", confidence: 0.97 }] }) };
  };
  try {
    const result = await ocrService.callPaddleOcrService("data:image/jpeg;base64,aGVsbG8=");
    assert.equal(request.url, "http://ocr.internal/ocr");
    assert.equal(request.options.headers.Authorization, "Bearer unit-test-token");
    assert.ok(request.options.body instanceof FormData);
    assert.equal(result.rawText, "EXP 08/2027");
    assert.equal(result.lines[0].confidence, 0.97);
    assert.equal(result.confidence, 0.97);
    assert.equal(result.source, "paddleocr");
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.PADDLE_OCR_URL; else process.env.PADDLE_OCR_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PADDLE_OCR_TOKEN; else process.env.PADDLE_OCR_TOKEN = oldToken;
  }
});

test("PaddleOCR errors are sanitized and report timeouts clearly", async () => {
  const oldUrl = process.env.PADDLE_OCR_URL;
  const oldFetch = global.fetch;
  process.env.PADDLE_OCR_URL = "http://ocr.internal/ocr";
  global.fetch = async () => { throw new Error("internal address and secret"); };
  try {
    await assert.rejects(ocrService.callPaddleOcrService("data:image/jpeg;base64,aGVsbG8="), /PaddleOCR service is unavailable/);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.PADDLE_OCR_URL; else process.env.PADDLE_OCR_URL = oldUrl;
  }
});

test("OCR and Gemini failure returns the clear manual-entry fallback", async () => {
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  mockOcr = async () => { throw new Error("OCR down"); };
  mockGemini = async () => { throw new Error("model down"); };
  try {
    const result = await extractDates({ image: "data:image/jpeg;base64,photo" });
    assert.equal(result.status, "manual_entry");
    assert.equal(result.message, FALLBACK_MESSAGE);
    assert.ok(result.warnings.length);
  } finally {
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
  }
});

test("Gemini structured fields retain field-specific labels and uncertainty", () => {
  const normalized = normalizeGeminiFields({ packaging_date: "May 2027", best_before_date: "08/2027", uncertain_fields: ["best_before_date"] });
  assert.equal(normalized.candidates[0].date_type, "packaging_date");
  assert.equal(normalized.candidates[0].normalized_date, "2027-05");
  assert.equal(normalized.candidates[1].date_type, "best_before_date");
  assert.equal(normalized.candidates[1].uncertain, true);
});

test("same-type disagreements are not silently collapsed", () => {
  const merged = mergeCandidates(
    [{ date_type: "expiry_date", raw_value: "12/2027", normalized_date: "2027-12-31", source: "tesseract" }],
    [{ date_type: "expiry_date", raw_value: "11/2027", normalized_date: "2027-11-30", source: "gemini_image" }]
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.every((item) => item.conflict));
});

test("confirmed date extraction metadata persists with the physical inventory record", async () => {
  const previousProvider = process.env.STORAGE_PROVIDER;
  process.env.STORAGE_PROVIDER = "json";
  const id = `date-metadata-${Date.now()}`;
  const storeId = `date-test-store-${Date.now()}`;
  try {
    const saved = await inventoryRepository.save({
      id,
      barcode: "8900000000017",
      product_name: "Date metadata test fixture",
      batch: "LOT-42",
      mfg_date: "2026-05-13",
      expiry_date: "2027-06-14",
      date_metadata: { raw_visible_text: "MFG 13/05/2026 EXP 14/06/2027", verification_status: "shopkeeper_confirmed", candidates: [{ date_type: "expiry_date", raw_value: "14/06/2027", normalized_date: "2027-06-14", precision: "day", source: "tesseract" }] }
    }, storeId);
    const readBack = await inventoryRepository.get(id, storeId);
    assert.equal(saved.date_metadata.verification_status, "shopkeeper_confirmed");
    assert.equal(readBack.date_metadata.candidates[0].normalized_date, "2027-06-14");
  } finally {
    await inventoryRepository.remove(id, storeId);
    if (previousProvider === undefined) delete process.env.STORAGE_PROVIDER; else process.env.STORAGE_PROVIDER = previousProvider;
  }
});
