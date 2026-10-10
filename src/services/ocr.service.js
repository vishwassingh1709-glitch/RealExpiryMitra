/**
 * Production-ready OCR service for reading expiry labels and text.
 * Supports:
 * 1. Tesseract.js (Open-source, runs locally without paid API keys)
 * 2. OCR.space API (Cloud OCR service when OCR_API_KEY is configured)
 * 3. Test-only mock mode
 */

const { isValidImagePayload } = require("../middleware/validate.middleware");
let Tesseract;
try {
  Tesseract = require("tesseract.js");
} catch (_) {
  // Graceful fallback if tesseract not available
}

class OcrError extends Error {
  constructor(message, statusCode = 500, isTransient = false) {
    super(message);
    this.name = "OcrError";
    this.statusCode = statusCode;
    this.isTransient = isTransient;
  }
}

function getTimeoutMs() {
  const parsed = Number(process.env.EXTERNAL_API_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function isImageData(value) {
  return isValidImagePayload(value);
}

/**
 * Normalizes messy OCR output without corrupting date characters.
 */
function normalizeOcrText(text) {
  if (typeof text !== "string") return "";

  let cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ");

  // Normalize spaced letters in standard keywords: "E X P" -> "EXP", "M F G" -> "MFG"
  cleaned = cleaned.replace(/\bM\s+F\s+G\b/gi, "MFG");
  cleaned = cleaned.replace(/\bM\s+F\s+D\b/gi, "MFD");
  cleaned = cleaned.replace(/\bP\s+K\s+D\b/gi, "PKD");
  cleaned = cleaned.replace(/\bE\s+X\s+P\b/gi, "EXP");
  cleaned = cleaned.replace(/\bL\s+O\s+T\b/gi, "LOT");
  cleaned = cleaned.replace(/\bB\s+E\s+S\s+T\s+B\s+E\s+F\s+O\s+R\s+E\b/gi, "BEST BEFORE");
  cleaned = cleaned.replace(/\bU\s+S\s+E\s+B\s+Y\b/gi, "USE BY");

  // Join lines where a label is separated from its value by a newline
  cleaned = cleaned.replace(
    /\b(MFG|MFD|EXP|EXPIRY|USE BY|BEST BEFORE|BEST BY|BATCH|LOT|B\.NO|BN|PKD|PACKED)\b\s*[:\s]*\n+[:\s]*/gi,
    "$1: "
  );

  // Normalize spaces around label colons on the same line: "MFG : 01/01/2026" -> "MFG: 01/01/2026"
  cleaned = cleaned.replace(
    /\b(MFG|MFD|EXP|EXPIRY|USE BY|BEST BEFORE|BEST BY|BATCH|LOT|B\.NO|BN|PKD|PACKED)\s*:\s*/gi,
    "$1: "
  );

  // Fix spaced separators in dates: "11 / 06 / 2026" -> "11/06/2026"
  cleaned = cleaned.replace(
    /(\d{1,2})\s*([\/\-\.])\s*(\d{1,2})\s*([\/\-\.])\s*(\d{2,4})/g,
    "$1$2$3$4$5"
  );
  cleaned = cleaned.replace(
    /(\d{1,2})\s*([\/\-\.])\s*(\d{4})/g,
    "$1$2$3"
  );

  // Collapse excessive inline spaces while preserving newlines
  cleaned = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return cleaned.trim();
}

/**
 * Calls OCR.space API with timeout and safe response parsing.
 */
async function callOcrSpaceApi(image) {
  const apiUrl = process.env.OCR_API_URL || "https://api.ocr.space/parse/image";
  const apiKey = process.env.OCR_API_KEY;

  if (!apiKey) {
    throw new OcrError("OCR_API_KEY is not configured for OCR.space", 500, false);
  }

  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const language = process.env.OCR_LANGUAGE || "eng";
    const engine = String(process.env.OCR_ENGINE || "2");

    const params = new URLSearchParams({
      apikey: apiKey,
      base64Image: image,
      language,
      OCREngine: engine,
      isOverlayRequired: "false",
      scale: "true",
      detectOrientation: "true"
    });

    const response = await fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    if (!response.ok) {
      const isTransient = response.status >= 500;
      throw new OcrError(`OCR HTTP ${response.status}`, response.status, isTransient);
    }

    const data = await response.json();

    if (Array.isArray(data.ParsedResults)) {
      if (data.IsErroredOnProcessing && (!data.ParsedResults.length || !data.ParsedResults[0].ParsedText)) {
        const errorMsg = Array.isArray(data.ErrorMessage)
          ? data.ErrorMessage.join("; ")
          : (data.ErrorMessage || "OCR processing failed");
        throw new OcrError(errorMsg, 422, false);
      }

      const parsedText = data.ParsedResults.map((r) => r.ParsedText || "").join("\n").trim();
      return {
        rawText: parsedText,
        confidence: 0.92,
        source: "ocr_space"
      };
    }

    throw new OcrError("Invalid response structure from OCR.space", 502, true);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new OcrError("OCR request timed out", 504, true);
    }
    if (error instanceof OcrError) throw error;
    throw new OcrError(`OCR request failed: ${error.message}`, 502, true);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extracts raw image buffer from data URL or base64 string for Tesseract.
 */
function extractImageBuffer(imagePayload) {
  let cleanBase64 = imagePayload;
  if (imagePayload.includes(",")) {
    cleanBase64 = imagePayload.split(",")[1];
  }
  return Buffer.from(cleanBase64, "base64");
}

/**
 * Runs local OCR using Tesseract.js.
 */
const path = require("path");

async function callTesseract(image) {
  if (!Tesseract) {
    throw new OcrError("Tesseract.js is not available in the current environment", 500, false);
  }

  const timeoutMs = getTimeoutMs();
  const imageBuffer = extractImageBuffer(image);

  const tesseractPromise = (async () => {
    const lang = process.env.OCR_LANGUAGE || "eng";
    const localDataPath = path.resolve(__dirname, "../../");
    const options = {
      langPath: localDataPath,
      errorHandler: (e) => console.warn("[Tesseract warn]", e)
    };
    const { data } = await Tesseract.recognize(imageBuffer, lang, options);
    return {
      rawText: (data && data.text ? data.text : "").trim(),
      confidence: data && typeof data.confidence === "number" ? Math.round(data.confidence) / 100 : 0.85,
      source: "tesseract"
    };
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Tesseract OCR processing timed out")), timeoutMs)
  );

  return Promise.race([tesseractPromise, timeoutPromise]);
}

/**
 * Public service method to extract and normalize text from image.
 */
async function extractText(image) {
  if (!isImageData(image)) {
    return {
      rawText: "",
      normalizedText: "",
      confidence: 0,
      source: "invalid_image"
    };
  }

  const ocrMode = (process.env.OCR_MODE || "").toLowerCase();
  const ocrProvider = (process.env.OCR_PROVIDER || "").toLowerCase();

  // Keep deterministic sample OCR results out of deployed application flows.
  if (process.env.NODE_ENV === "test" && (
    ocrMode === "mock" ||
    ocrProvider === "mock" ||
    image === "data:image/jpeg;base64,test"
  )) {
    const mockRaw = "MFG 12/06/2024 EXP 11/06/2026 BATCH A24B7";
    return {
      rawText: mockRaw,
      normalizedText: normalizeOcrText(mockRaw),
      confidence: 0.96,
      source: "mock"
    };
  }

  let result;
  let ocrError = null;

  if (ocrProvider === "ocr_space" || (process.env.OCR_API_KEY && ocrProvider !== "tesseract")) {
    try {
      result = await callOcrSpaceApi(image);
    } catch (err) {
      ocrError = err;
      console.warn(`[OCR] OCR.space failed: ${err.message}. Attempting Tesseract fallback...`);
      if (Tesseract) {
        try {
          result = await callTesseract(image);
          ocrError = null;
        } catch (tessErr) {
          console.error(`[OCR] Tesseract fallback failed: ${tessErr.message}`);
        }
      }
    }
  } else {
    // Default to Tesseract.js (open-source & free)
    try {
      result = await callTesseract(image);
    } catch (err) {
      ocrError = err;
      console.error(`[OCR] Tesseract failed: ${err.message}`);
    }
  }

  if (ocrError) {
    throw ocrError;
  }

  if (!result || typeof result.rawText !== "string") {
    throw new OcrError("No text could be extracted from image", 422, false);
  }

  const normalizedText = normalizeOcrText(result.rawText);

  return {
    rawText: result.rawText,
    normalizedText,
    confidence: result.confidence ?? 0.85,
    source: result.source
  };
}

module.exports = {
  extractText,
  normalizeOcrText,
  callOcrSpaceApi,
  callTesseract,
  isImageData,
  OcrError
};
