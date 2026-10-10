/**
 * AI & Rule-based Interpretation Service for Product Expiry Labels.
 * Integrates Google Gemini API with fallback to deterministic pattern recognition.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { parseDate, addMonthsToDate, addDaysToDate } = require("../utils/date.parser");
const { calculateConfidence } = require("../utils/confidence");

const DATE_PATTERN =
  "(\\d{1,2}[\\/\\-\\.]\\d{1,2}[\\/\\-\\.]\\d{2,4}|\\d{1,2}[\\/\\-\\.]\\d{2,4}|\\d{1,2}[\\s\\-\\/.][A-Za-z]{3,9}[\\s\\-\\/.][0-9]{2,4}|[A-Za-z]{3,9}[\\s\\-\\/.][0-9]{2,4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})";

const MFG_REGEX = new RegExp(
  "(?:MANUFACTURING\\s+DATE|MANUFACTURED\\s+ON|MANUFACTURED|DATE\\s+OF\\s+MFG|MFD\\s+DATE|MFD|MFG|PKD|PACKED)\\b[:\\s.]*" +
    DATE_PATTERN,
  "i"
);

const EXP_REGEX = new RegExp(
  "(?:BEST\\s+BEFORE\\s+DATE|BEST\\s+BEFORE|BEST\\s+BY|EXPIRY\\s+DATE|EXP\\s+DATE|EXPIRY|USE\\s+BY|EXP)\\b[:\\s.]*" +
    DATE_PATTERN,
  "i"
);

const RELATIVE_EXP_REGEX =
  /(?:BEST\s+BEFORE|USE\s+WITHIN|CONSUME\s+WITHIN)[:\s]*(\d{1,2})\s*(MONTHS?|DAYS?|WEEKS?)\s*(?:FROM\s+(?:MFG|MFD|PACKAGING|PKD|DATE\s+OF\s+MFG))?/i;

const BATCH_REGEX =
  /(?:BATCH\s*(?:NO|NUMBER)?|LOT\s*(?:NO|NUMBER)?|B\.NO|BN)\b[:\s.]*([A-Za-z0-9\-_]{2,20})/i;

function getAiTimeoutMs() {
  const parsed = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}

/**
 * Deterministic regex-based date and batch parser.
 */
function interpretExpiryDeterministic(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return {
      expiry_date: null,
      mfg_date: null,
      batch: null,
      confidence: 0,
      warnings: ["No text provided for analysis"],
      source: "deterministic_parser"
    };
  }

  const text = rawText.trim();
  const warnings = [];
  let mfgDate = null;
  let expiryDate = null;
  let batch = null;
  let hasMfgLabel = false;
  let hasExpiryLabel = false;

  // 1. Check for Manufacturing Date
  const mfgMatch = text.match(MFG_REGEX);
  if (mfgMatch && mfgMatch[1]) {
    hasMfgLabel = true;
    mfgDate = parseDate(mfgMatch[1], { isExpiry: false });
  }

  // 2. Check for Expiry Date
  const expMatch = text.match(EXP_REGEX);
  if (expMatch && expMatch[1]) {
    hasExpiryLabel = true;
    expiryDate = parseDate(expMatch[1], { isExpiry: true });
  }

  // 3. Fallback: line-by-line inspection if not matched in single regex
  if (!expiryDate) {
    const lines = text.split("\n");
    for (const line of lines) {
      const lineExp = line.match(EXP_REGEX);
      if (lineExp && lineExp[1]) {
        hasExpiryLabel = true;
        expiryDate = parseDate(lineExp[1], { isExpiry: true });
        if (expiryDate) break;
      }
    }
  }

  if (!mfgDate) {
    const lines = text.split("\n");
    for (const line of lines) {
      const lineMfg = line.match(MFG_REGEX);
      if (lineMfg && lineMfg[1]) {
        hasMfgLabel = true;
        mfgDate = parseDate(lineMfg[1], { isExpiry: false });
        if (mfgDate) break;
      }
    }
  }

  // 4. Check for Relative Expiry (e.g. "BEST BEFORE 6 MONTHS FROM MFG")
  if (!expiryDate) {
    const relMatch = text.match(RELATIVE_EXP_REGEX);
    if (relMatch && relMatch[1] && relMatch[2]) {
      hasExpiryLabel = true;
      const count = Number(relMatch[1]);
      const unit = relMatch[2].toUpperCase();
      if (mfgDate) {
        if (unit.startsWith("MONTH")) {
          expiryDate = addMonthsToDate(mfgDate, count);
        } else if (unit.startsWith("DAY")) {
          expiryDate = addDaysToDate(mfgDate, count);
        } else if (unit.startsWith("WEEK")) {
          expiryDate = addDaysToDate(mfgDate, count * 7);
        }
      } else {
        warnings.push(`Relative expiry found ("${count} ${unit}") but manufacturing date was not detected.`);
      }
    }
  }

  // 5. Batch Number
  const batchMatch = text.match(BATCH_REGEX);
  if (batchMatch && batchMatch[1]) {
    const candidate = batchMatch[1].trim().toUpperCase();
    if (!candidate.includes("/") && candidate.length >= 2) {
      batch = candidate;
    }
  }

  // Consistency check
  let datesConsistent = true;
  if (mfgDate && expiryDate && expiryDate < mfgDate) {
    datesConsistent = false;
    warnings.push("Extracted expiry date is earlier than manufacturing date.");
  }

  if (!expiryDate) {
    warnings.push("Expiry date could not be parsed definitively.");
  }

  const confidence = calculateConfidence({
    hasExpiryLabel,
    hasExpiryDate: Boolean(expiryDate),
    hasMfgLabel,
    hasMfgDate: Boolean(mfgDate),
    hasBatch: Boolean(batch),
    datesConsistent,
    isAmbiguous: !expiryDate || !datesConsistent
  });

  return {
    mfg_date: mfgDate,
    expiry_date: expiryDate,
    batch,
    confidence,
    warnings,
    source: "deterministic_parser"
  };
}

/**
 * Calls Google Gemini API to interpret OCR text.
 */
async function callGeminiApi(rawText, productInfo = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  });

  const prompt = `You are a food safety AI specialist analyzing OCR text extracted from food and grocery product packaging.
Product context (if known): Name: "${productInfo.name || ""}", Brand: "${productInfo.brand || ""}".

Analyze this OCR text:
---
${rawText}
---

Your task:
1. Identify the manufacturing or packaging date (MFG, MFD, PKD, PACKED, MANUFACTURED).
2. Identify the expiry date (EXP, EXPIRY, BEST BEFORE, USE BY, BEST BY).
3. If there is a relative expiry statement such as "BEST BEFORE X MONTHS FROM MFG", calculate the expiry date ONLY IF the manufacturing date is known.
4. Extract the batch or lot number if present.
5. Identify any warnings or ambiguities.

Rules:
- Format all dates in ISO YYYY-MM-DD.
- If a date is ambiguous (e.g. 05/06/2026 where day/month cannot be determined with certainty), note the ambiguity in warnings.
- NEVER invent or guess dates not supported by the OCR text.
- If expiry date is missing, return null for expiry_date.
- Return a JSON object with this EXACT structure:
{
  "mfg_date": "YYYY-MM-DD" or null,
  "expiry_date": "YYYY-MM-DD" or null,
  "batch": "string" or null,
  "confidence": number between 0.1 and 0.98,
  "warnings": ["string explanation of any uncertainty"],
  "notes": "short rationale"
}`;

  const timeoutMs = getAiTimeoutMs();
  const generatePromise = (async () => {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    let cleaned = responseText.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    }
    return JSON.parse(cleaned);
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Gemini AI request timed out")), timeoutMs)
  );

  return Promise.race([generatePromise, timeoutPromise]);
}

/**
 * Identify product details visible in a package photo. This is deliberately a
 * suggestion-only path; barcode association and shopkeeper confirmation remain
 * the responsibility of the product identification workflow.
 */
async function identifyProductFromImage(imageData, barcode, { signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  if (typeof imageData !== "string" || imageData.length > 10 * 1024 * 1024) throw new Error("Product image is missing or too large");
  const match = imageData.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("Product image must be JPEG, PNG, or WebP data");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_PRODUCT_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash",
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
  });
  const prompt = `Identify the single packaged retail product, if clearly visible, in this photo. The barcode decoded from this same package image is ${JSON.stringify(barcode)}. Use visual packaging text and brand marks only. Do not guess missing details and do not infer expiry, manufacturing date, batch, price, or barcode digits. If the photo is a close-up of only a barcode, blurry, ambiguous, or contains multiple plausible products, set product_visible to false. Return JSON only with this shape: {"product_visible":boolean,"name":string|null,"brand":string|null,"category":string|null,"packaging_evidence":string|null,"confidence":number}. Confidence must reflect visible packaging evidence.`;
  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: match[1].toLowerCase().replace("jpg", "jpeg"), data: match[2] } }
  ], { signal, timeout: Number(process.env.PRODUCT_IDENTIFICATION_TIMEOUT_MS || 8000) });
  let text = result.response.text().trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const candidate = JSON.parse(text);
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const evidence = typeof candidate.packaging_evidence === "string" ? candidate.packaging_evidence.trim() : "";
  const confidence = Number(candidate.confidence);
  if (candidate.product_visible !== true || !name || !evidence || !Number.isFinite(confidence) || confidence < 0.65) return null;
  return {
    barcode,
    name: name.slice(0, 180),
    brand: typeof candidate.brand === "string" ? candidate.brand.trim().slice(0, 100) : "",
    category: typeof candidate.category === "string" ? candidate.category.trim().slice(0, 100) : "",
    image_url: null,
    packaging_evidence: evidence.slice(0, 240),
    confidence: Math.min(1, Math.max(0, confidence)),
    source: "gemini_candidate",
    source_label: "Gemini photo suggestion",
    verification_status: "unverified"
  };
}

/** Reads date and lot text from the supplied package-label photo only. */
async function identifyDatesFromImage(imageData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const match = typeof imageData === "string" && imageData.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || imageData.length > 10 * 1024 * 1024) throw new Error("A valid label photo is required");
  const timeoutMs = Number(process.env.DATE_GEMINI_TIMEOUT_MS || 8000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000);
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      generationConfig: { temperature: 0, responseMimeType: "application/json" }
    });
    const prompt = `Read only text visibly printed in this date/batch label photograph. Do not use the product name, barcode, typical shelf life, or outside knowledge to infer any date. Preserve printed date precision and wording. If unreadable or uncertain, return null for that field and list it in uncertain_fields. Return JSON only: {"manufacturing_date":string|null,"packaging_date":string|null,"expiry_date":string|null,"best_before_date":string|null,"batch_number":string|null,"raw_visible_text":string,"uncertain_fields":string[]}. Dates must be returned exactly as printed, not normalized or completed. Keep expiry/use-by distinct from best-before and packaging date.`;
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: match[1].toLowerCase().replace("jpg", "jpeg"), data: match[2] } }
    ], { signal: controller.signal, timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000 });
    let responseText = result.response.text().trim();
    if (responseText.startsWith("```")) responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(responseText);
    const fields = ["manufacturing_date", "packaging_date", "expiry_date", "best_before_date", "batch_number"];
    for (const field of fields) {
      if (parsed[field] === undefined) parsed[field] = null;
      if (parsed[field] !== null && typeof parsed[field] !== "string") throw new Error("Invalid Gemini field type");
      if (typeof parsed[field] === "string") parsed[field] = parsed[field].slice(0, 120);
    }
    parsed.raw_visible_text = typeof parsed.raw_visible_text === "string" ? parsed.raw_visible_text.slice(0, 1000) : "";
    parsed.uncertain_fields = Array.isArray(parsed.uncertain_fields) ? parsed.uncertain_fields.map(String).slice(0, 10) : [];
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Main interpretation function with Gemini AI and deterministic parser fallback.
 */
async function interpretExpiry(rawText, productInfo = {}) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return {
      expiry_date: null,
      mfg_date: null,
      batch: null,
      confidence: 0,
      warnings: ["Empty text"],
      source: "none"
    };
  }

  // 1. Mock mode for unit tests
  if (process.env.NODE_ENV === "test" && process.env.AI_MODE === "mock") {
    return interpretExpiryDeterministic(rawText);
  }

  // 2. Try Gemini AI if API key is present
  if (process.env.GEMINI_API_KEY) {
    try {
      const aiResponse = await callGeminiApi(rawText, productInfo);

      // Validate AI returned dates
      let expiryDate = null;
      if (aiResponse.expiry_date) {
        expiryDate = parseDate(aiResponse.expiry_date, { isExpiry: true });
      }

      let mfgDate = null;
      if (aiResponse.mfg_date) {
        mfgDate = parseDate(aiResponse.mfg_date, { isExpiry: false });
      }

      const warnings = Array.isArray(aiResponse.warnings) ? aiResponse.warnings : [];
      let confidence = typeof aiResponse.confidence === "number" ? aiResponse.confidence : 0.85;

      // Consistency check on AI result
      if (mfgDate && expiryDate && expiryDate < mfgDate) {
        warnings.push("Extracted expiry date cannot be earlier than manufacturing date.");
        confidence = Math.min(confidence, 0.4);
      }

      return {
        mfg_date: mfgDate,
        expiry_date: expiryDate,
        batch: aiResponse.batch || null,
        confidence: Math.round(confidence * 100) / 100,
        warnings,
        source: "gemini_ai"
      };
    } catch (error) {
      console.warn(`[AI Service] Gemini call failed (${error.message}). Falling back to deterministic parser.`);
    }
  }

  // 3. Fallback to deterministic regex parser
  return interpretExpiryDeterministic(rawText);
}

module.exports = {
  interpretExpiry,
  interpretExpiryDeterministic,
  callGeminiApi,
  identifyProductFromImage,
  identifyDatesFromImage,
  MFG_REGEX,
  EXP_REGEX,
  RELATIVE_EXP_REGEX,
  BATCH_REGEX
};
