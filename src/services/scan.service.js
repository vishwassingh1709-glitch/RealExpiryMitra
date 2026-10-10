/**
 * Scan orchestration service coordinating lookup, OCR, AI interpretation, validation, and scan audit logging.
 */

const { findProduct } = require("./product.service");
const { extractText } = require("./ocr.service");
const { interpretExpiry } = require("./ai.service");
const { validate } = require("./validation.service");
const inventory = require("./inventory.service");
const scanHistoryService = require("./scan-history.service");

async function processScan({ barcode, image, autoSave = false }) {
  const normalizedBarcode = String(barcode || "").trim();

  if (!normalizedBarcode) {
    return {
      httpStatus: 400,
      body: {
        status: "error",
        message: "barcode is required"
      }
    };
  }

  // 1. Product Lookup (Local / Firestore repository -> Open Food Facts)
  const productResult = await findProduct(normalizedBarcode);
  const isProductFound = productResult.status === "found" && productResult.product;

  const product = isProductFound
    ? productResult.product
    : {
        barcode: normalizedBarcode,
        name: "",
        brand: "",
        category: "Other",
        source: "unregistered"
      };

  // 2. OCR Execution
  let ocr;
  try {
    ocr = await extractText(image);
  } catch (error) {
    console.error("[Scan Service] OCR error:", error.message);
    await scanHistoryService.record({
      barcode: normalizedBarcode,
      ocr_status: "failed",
      raw_text: null,
      error: error.message
    });
    return {
      httpStatus: 200,
      body: {
        status: "ocr_error",
        barcode: normalizedBarcode,
        product,
        product_found: isProductFound,
        message: error.message || "Unable to read expiry information. Please retry with a clearer photo."
      }
    };
  }

  if (!ocr || !ocr.rawText || !ocr.rawText.trim()) {
    await scanHistoryService.record({
      barcode: normalizedBarcode,
      ocr_status: "empty",
      raw_text: ""
    });
    return {
      httpStatus: 200,
      body: {
        status: "ocr_error",
        barcode: normalizedBarcode,
        product,
        product_found: isProductFound,
        message: "No text detected on the expiry label. Please hold steady and ensure good lighting."
      }
    };
  }

  // 3. AI / Deterministic Interpretation
  const textToParse = ocr.normalizedText || ocr.rawText;
  const interpretation = await interpretExpiry(textToParse, product);

  // 4. Validation
  const validation = validate(interpretation);

  // 5. Expiry Status & Days Remaining Calculation (if expiry date exists)
  const { days_left, status: expiry_status } = inventory.statusFor(
    interpretation.expiry_date
  );

  const candidateId = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 6. Record to Scan History Audit Trail
  await scanHistoryService.record({
    barcode: normalizedBarcode,
    product_name: product.name,
    ocr_status: "success",
    raw_text: ocr.rawText,
    candidate_mfg_date: interpretation.mfg_date,
    candidate_expiry_date: interpretation.expiry_date,
    batch: interpretation.batch,
    confidence: interpretation.confidence,
    source: interpretation.source || ocr.source,
    warnings: interpretation.warnings || []
  }).catch((err) => console.warn("[Scan History error]", err.message));

  // 7. Optional autoSave flag (used in automated batch tests)
  let savedRecord = null;
  if (autoSave && validation.accepted && isProductFound) {
    savedRecord = await inventory.create({
      barcode: normalizedBarcode,
      product_name: product.name,
      brand: product.brand,
      batch: interpretation.batch,
      mfg_date: interpretation.mfg_date,
      expiry_date: interpretation.expiry_date,
      quantity: 1,
      confidence: interpretation.confidence,
      source: "ocr",
      review_status: "confirmed"
    });
  }

  const responseStatus = validation.accepted
    ? "confident"
    : validation.reason === "invalid"
    ? "invalid"
    : "low_confidence";

  return {
    httpStatus: 200,
    body: {
      status: responseStatus,
      product,
      product_found: isProductFound,
      needs_confirmation: true,
      expiry: {
        raw_text: ocr.rawText,
        normalized_text: ocr.normalizedText,
        parsed_expiry_date: interpretation.expiry_date,
        parsed_mfg_date: interpretation.mfg_date,
        expiry_date: interpretation.expiry_date,
        mfg_date: interpretation.mfg_date,
        batch: interpretation.batch,
        confidence: interpretation.confidence,
        source: interpretation.source,
        warnings: interpretation.warnings || []
      },
      days_left: interpretation.expiry_date ? days_left : null,
      expiry_status: interpretation.expiry_date ? expiry_status : "unknown",
      record_id: savedRecord ? savedRecord.id : candidateId,
      message: validation.accepted
        ? "Expiry information detected successfully. Please review and confirm."
        : validation.message
    }
  };
}

module.exports = { processScan };
