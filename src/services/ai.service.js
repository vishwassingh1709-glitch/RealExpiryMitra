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
  if (process.env.AI_MODE === "mock") {
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
  MFG_REGEX,
  EXP_REGEX,
  RELATIVE_EXP_REGEX,
  BATCH_REGEX
};
