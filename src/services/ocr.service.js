/**
 * Production-ready OCR service for reading expiry labels and text.
 * Supports:
 * 1. Tesseract.js (Open-source, runs locally without paid API keys)
 * 2. OCR.space API (Cloud OCR service when OCR_API_KEY is configured)
 * 3. Test-only mock mode
 */

const { isValidImagePayload } = require("../middleware/validate.middleware");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
let Tesseract;
try {
  Tesseract = require("tesseract.js");
} catch (_) {
  // Graceful fallback if tesseract not available
}

// Tesseract.recognize() creates and tears down an OCR worker on each call.
// Keep one initialized worker per Node process and queue requests through it.
let tesseractWorkerPromise = null;
let tesseractQueue = Promise.resolve();

function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    const lang = process.env.OCR_LANGUAGE || "eng";
    const langPath = path.resolve(__dirname, "../../");
    tesseractWorkerPromise = Tesseract.createWorker(lang, undefined, {
      langPath,
      errorHandler: () => console.warn("[Tesseract warn] worker reported an error")
    }).catch((error) => {
      tesseractWorkerPromise = null;
      throw error;
    });
  }
  return tesseractWorkerPromise;
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
  const started = performance.now();
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
        confidence: null,
        source: "ocr_space",
        timings: { inference_ms: Math.round(performance.now() - started) }
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

/** Sends the already-validated image to the optional private PaddleOCR service. */
async function callPaddleOcrService(image) {
  const serviceUrl = process.env.PADDLE_OCR_URL;
  if (!serviceUrl) throw new OcrError("PaddleOCR service is not configured", 503, false);
  const timeoutMs = Math.min(getTimeoutMs(), Number(process.env.PADDLE_OCR_TIMEOUT_MS) || 20000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const imageBuffer = extractImageBuffer(image);
    const mime = /^data:(image\/(?:jpeg|png|webp));base64,/i.exec(image)?.[1] || "image/jpeg";
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const form = new FormData();
    form.append("file", new Blob([imageBuffer], { type: mime }), `date-label.${extension}`);
    const headers = {};
    if (process.env.PADDLE_OCR_TOKEN) headers.Authorization = `Bearer ${process.env.PADDLE_OCR_TOKEN}`;
    const response = await fetch(serviceUrl, { method: "POST", body: form, headers, signal: controller.signal });
    if (!response.ok) throw new OcrError(`PaddleOCR service returned HTTP ${response.status}`, response.status, response.status >= 500);
    const payload = await response.json();
    if (!Array.isArray(payload.lines)) throw new OcrError("Invalid response from PaddleOCR service", 502, true);
    const lines = payload.lines
      .filter((line) => line && typeof line.text === "string" && line.text.trim())
      .map((line) => ({ text: line.text.trim(), confidence: Number.isFinite(line.confidence) ? line.confidence : null }));
    const scoredLines = lines.filter((line) => line.confidence !== null);
    return {
      rawText: lines.map((line) => line.text).join("\n"),
      lines,
      confidence: scoredLines.length ? scoredLines.reduce((sum, line) => sum + line.confidence, 0) / scoredLines.length : null,
      source: "paddleocr",
      timings: { inference_ms: Math.round(performance.now() - started), ...(payload.timings || {}) }
    };
  } catch (error) {
    if (error.name === "AbortError") throw new OcrError("PaddleOCR request timed out", 504, true);
    if (error instanceof OcrError) throw error;
    throw new OcrError("PaddleOCR service is unavailable", 502, true);
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
async function callTesseract(image) {
  if (!Tesseract) {
    throw new OcrError("Tesseract.js is not available in the current environment", 500, false);
  }

  const timeoutMs = getTimeoutMs();
  const imageBuffer = extractImageBuffer(image);
  const queuedAt = performance.now();
  const ocrPromise = tesseractQueue.then(async () => {
    const workerInitStarted = performance.now();
    // Requests that expired while queued should not consume CPU later.
    if (performance.now() - queuedAt >= timeoutMs) {
      throw new OcrError("Tesseract OCR processing timed out", 504, true);
    }
    const worker = await getTesseractWorker();
    const initializationMs = performance.now() - workerInitStarted;
    const inferenceStarted = performance.now();
    const { data } = await worker.recognize(imageBuffer);
    return {
      rawText: (data && data.text ? data.text : "").trim(),
      confidence: data && typeof data.confidence === "number" ? Math.round(data.confidence) / 100 : null,
      source: "tesseract",
      timings: {
        queue_ms: Math.round(Math.max(0, inferenceStarted - queuedAt - initializationMs)),
        initialization_ms: Math.round(initializationMs),
        inference_ms: Math.round(performance.now() - inferenceStarted)
      }
    };
  });
  // A failed scan must not poison the process-wide queue.
  tesseractQueue = ocrPromise.catch(() => {});

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new OcrError("Tesseract OCR processing timed out", 504, true)), timeoutMs);
  });
  try {
    return await Promise.race([ocrPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
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
  const providerStarted = performance.now();

  // An explicitly configured PaddleOCR service is preferred. Retain the
  // existing OCR.space/Tesseract providers as graceful fallbacks.
  if (process.env.PADDLE_OCR_URL) {
    try {
      result = await callPaddleOcrService(image);
    } catch (err) {
      ocrError = err;
      console.warn("[OCR] PaddleOCR unavailable; trying the configured fallback.");
    }
  }

  if (!result && (ocrProvider === "ocr_space" || (process.env.OCR_API_KEY && ocrProvider !== "tesseract"))) {
    try {
      result = await callOcrSpaceApi(image);
    } catch (err) {
      ocrError = err;
      console.warn("[OCR] OCR.space failed; attempting Tesseract fallback.");
      if (Tesseract) {
        try {
          result = await callTesseract(image);
          ocrError = null;
        } catch (tessErr) {
          console.error("[OCR] Tesseract fallback failed.");
        }
      }
    }
  } else if (!result && Tesseract) {
    // Default to Tesseract.js (open-source & free)
    try {
      result = await callTesseract(image);
    } catch (err) {
      ocrError = err;
      console.error("[OCR] Tesseract failed.");
    }
  }

  // A successful configured fallback supersedes a preceding Paddle failure.
  if (result) ocrError = null;

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
    confidence: result.confidence ?? null,
    source: result.source,
    lines: result.lines,
    timings: {
      ...(result.timings || {}),
      provider_ms: Math.round(performance.now() - providerStarted)
    }
  };
}

module.exports = {
  extractText,
  normalizeOcrText,
  callOcrSpaceApi,
  callPaddleOcrService,
  callTesseract,
  getTesseractWorker,
  isImageData,
  OcrError
};
