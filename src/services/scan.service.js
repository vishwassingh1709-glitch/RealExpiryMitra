/** Barcode plus printed-date scan orchestration. All extracted values are review-only. */

const { findProduct } = require("./product.service");
const dateExtraction = require("./date-extraction.service");
const inventory = require("./inventory.service");
const scanHistoryService = require("./scan-history.service");

function confirmedCandidate(candidates, type) {
  const safe = candidates.filter((item) => item.date_type === type && item.normalized_date && !item.uncertain && !item.conflict && item.precision === "day" && item.source !== "gemini_image");
  const values = [...new Set(safe.map((item) => item.normalized_date))];
  return values.length === 1 ? safe.find((item) => item.normalized_date === values[0]) : null;
}

function batchCandidate(candidates) {
  const matches = candidates.filter((item) => item.date_type === "batch_number" && item.raw_value && !item.uncertain && !item.conflict && item.source !== "gemini_image");
  const values = [...new Set(matches.map((item) => item.raw_value))];
  return values.length === 1 ? values[0] : null;
}

async function processScan({ barcode, image, storeId = "store_default" }) {
  const normalizedBarcode = String(barcode || "").trim();
  if (!normalizedBarcode) return { httpStatus: 400, body: { status: "error", message: "barcode is required" } };

  const productResult = await findProduct(normalizedBarcode, storeId);
  const productFound = productResult.status === "found" && productResult.product;
  const product = productFound ? productResult.product : { barcode: normalizedBarcode, name: "", brand: "", category: "Other", source: "unregistered" };

  let extracted;
  try {
    extracted = await dateExtraction.extractDates({ barcode: normalizedBarcode, image });
  } catch (error) {
    console.error("[Scan Service] Date extraction error:", error.message);
    await scanHistoryService.record({ barcode: normalizedBarcode, store_id: storeId, ocr_status: "failed", raw_text: null, error: error.message }).catch(() => {});
    return { httpStatus: 200, body: { status: "manual_entry", barcode: normalizedBarcode, product, product_found: Boolean(productFound), needs_confirmation: true, message: dateExtraction.FALLBACK_MESSAGE, expiry: { candidates: [], warnings: ["Date extraction unavailable"] } } };
  }

  const candidates = extracted.candidates || [];
  const mfg = confirmedCandidate(candidates, "manufacturing_date");
  const packaging = confirmedCandidate(candidates, "packaging_date");
  const expiry = confirmedCandidate(candidates, "expiry_date");
  const bestBefore = confirmedCandidate(candidates, "best_before_date");
  const batch = batchCandidate(candidates);
  const expiryDate = expiry?.normalized_date || null;
  const mfgDate = mfg?.normalized_date || null;
  const { days_left, status: expiry_status } = inventory.statusFor(expiryDate);
  await scanHistoryService.record({
    barcode: normalizedBarcode,
    store_id: storeId,
    product_name: product.name,
    ocr_status: extracted.status === "review_required" ? "review_required" : "manual_entry",
    raw_text: extracted.raw_visible_text || "",
    candidate_mfg_date: mfgDate,
    candidate_expiry_date: expiryDate,
    batch,
    source: [extracted.sources?.ocr, extracted.sources?.gemini, extracted.sources?.gs1 ? "gs1_barcode" : null].filter(Boolean).join(",") || "none",
    warnings: extracted.warnings || []
  }).catch((error) => console.warn("[Scan History error]", error.message));

  // Deliberately ignore legacy auto_save flags: extracted values require a user review and explicit confirmation.
  return {
    httpStatus: 200,
    body: {
      status: extracted.status,
      product,
      product_found: Boolean(productFound),
      needs_confirmation: true,
      expiry: {
        raw_text: extracted.raw_visible_text || "",
        normalized_text: extracted.raw_visible_text || "",
        parsed_expiry_date: expiryDate,
        parsed_mfg_date: mfgDate,
        expiry_date: expiryDate,
        mfg_date: mfgDate,
        packaging_date: packaging?.normalized_date || null,
        best_before_date: bestBefore?.normalized_date || null,
        batch,
        candidates,
        date_metadata: { raw_visible_text: extracted.raw_visible_text || "", candidates, extraction_methods: [extracted.sources?.ocr, extracted.sources?.gemini, extracted.sources?.gs1 ? "gs1_barcode" : null].filter(Boolean) },
        confidence: null,
        source: extracted.sources,
        warnings: extracted.warnings || []
      },
      days_left: expiryDate ? days_left : null,
      expiry_status: expiryDate ? expiry_status : "unknown",
      record_id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      message: extracted.message
    }
  };
}

module.exports = { processScan, confirmedCandidate, batchCandidate };
