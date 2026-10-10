const { extractText, isImageData } = require("./ocr.service");
const { identifyDatesFromImage } = require("./ai.service");
const { parseDateLabelText, normalizeGeminiFields } = require("../utils/date-label.parser");
const { parseGs1Barcode } = require("../utils/gs1");

const FALLBACK_MESSAGE = "We couldn't read the printed date clearly. Please retake the photo or enter the date manually.";

function hasUsableDate(candidates) {
  return candidates.some((item) => item.date_type !== "batch_number" && item.normalized_date && !item.uncertain && !item.conflict);
}

function mergeCandidates(...groups) {
  const merged = [];
  for (const candidate of groups.flat()) {
    const duplicate = merged.find((item) => item.date_type === candidate.date_type && item.normalized_date === candidate.normalized_date && item.raw_value === candidate.raw_value);
    if (!duplicate) merged.push(candidate);
  }
  for (const candidate of merged) {
    const alternatives = merged.filter((item) => item !== candidate && item.date_type === candidate.date_type && (
      (item.normalized_date && candidate.normalized_date && item.normalized_date !== candidate.normalized_date) ||
      (!item.normalized_date && !candidate.normalized_date && item.raw_value !== candidate.raw_value)
    ));
    if (alternatives.length) candidate.conflict = true;
  }
  return merged;
}

async function extractDates({ barcode = "", image, imageVariants = [] } = {}) {
  if (!isImageData(image)) return { status: "invalid_image", message: "Upload a valid close-up image of the printed date label." };
  const gs1Candidates = parseGs1Barcode(barcode);
  const ocrRuns = [image, ...imageVariants.slice(0, 1).filter(isImageData)];
  const ocrCandidates = [];
  const rawTexts = [];
  const ocrLines = [];
  let ocrSource = null;
  for (let index = 0; index < ocrRuns.length; index += 1) {
    try {
      const result = await extractText(ocrRuns[index]);
      ocrSource ||= result.source;
      if (Array.isArray(result.lines)) ocrLines.push(...result.lines);
      if (result.rawText) {
        rawTexts.push(result.rawText);
        const parsed = parseDateLabelText(result.normalizedText || result.rawText, result.source || "ocr");
        ocrCandidates.push(...parsed.candidates);
      }
    } catch (error) {
      if (index === 0) rawTexts.push(`OCR unavailable: ${error.message}`);
    }
    if (hasUsableDate(mergeCandidates(ocrCandidates))) break;
  }

  let geminiResult = { candidates: [], raw_visible_text: "", uncertain_fields: [] };
  const reviewedOcrCandidates = mergeCandidates(ocrCandidates);
  const ocrNeedsHelp = !hasUsableDate(reviewedOcrCandidates) || reviewedOcrCandidates.some((candidate) => candidate.uncertain || candidate.conflict);
  if (ocrNeedsHelp && process.env.GEMINI_API_KEY) {
    try {
      const ai = await identifyDatesFromImage(image);
      geminiResult = normalizeGeminiFields(ai, ai.raw_visible_text || "");
    } catch (error) {
      // OCR and human correction remain available when the optional model fails.
      geminiResult.error = error.name === "AbortError" ? "Gemini request timed out" : "Gemini image interpretation unavailable";
    }
  }

  const candidates = mergeCandidates(gs1Candidates, ocrCandidates, geminiResult.candidates);
  const usable = candidates.some((candidate) => candidate.date_type !== "batch_number" && candidate.normalized_date);
  return {
    status: usable ? "review_required" : "manual_entry",
    message: usable ? "Review each printed date and confirm or correct it before saving." : FALLBACK_MESSAGE,
    candidates,
    raw_visible_text: geminiResult.raw_visible_text || rawTexts.filter((text) => !text.startsWith("OCR unavailable:")).join("\n").slice(0, 2000),
    sources: { ocr: ocrSource, gemini: geminiResult.candidates.length ? "gemini_image" : null, gs1: gs1Candidates.length > 0 },
    ocr_lines: ocrLines.slice(0, 200),
    warnings: [...(geminiResult.error ? [geminiResult.error] : []), ...candidates.filter((item) => item.uncertain).map((item) => item.reason || `${item.date_type} needs review`)],
    requires_confirmation: true
  };
}

module.exports = { extractDates, mergeCandidates, hasUsableDate, FALLBACK_MESSAGE };
