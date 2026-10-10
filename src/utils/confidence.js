/**
 * Confidence calculation utility for OCR & date extraction.
 */

const CONFIDENCE_THRESHOLD = 0.75;

/**
 * Calculates a confidence score between 0 and 1.
 * @param {object} params
 * @param {number|null} [params.ocrConfidence]
 * @param {boolean} params.hasExpiryLabel
 * @param {boolean} params.hasExpiryDate
 * @param {boolean} [params.hasMfgLabel]
 * @param {boolean} [params.hasMfgDate]
 * @param {boolean} [params.hasBatch]
 * @param {boolean} [params.datesConsistent]
 * @param {boolean} [params.isAmbiguous]
 * @returns {number}
 */
function calculateConfidence({
  ocrConfidence = 0.9,
  hasExpiryLabel = false,
  hasExpiryDate = false,
  hasMfgLabel = false,
  hasMfgDate = false,
  hasBatch = false,
  datesConsistent = true,
  isAmbiguous = false
}) {
  if (isAmbiguous || !hasExpiryDate) {
    return 0.45;
  }

  if (!datesConsistent) {
    return 0.30;
  }

  // Base score from successful expiry date parsing
  let score = 0.70;

  // Boost for explicit expiry label (EXP, USE BY, BEST BEFORE, etc.)
  if (hasExpiryLabel) {
    score += 0.15;
  }

  // Boost for valid manufacturing date & label
  if (hasMfgDate && hasMfgLabel) {
    score += 0.05;
  }

  // Slight boost for batch presence
  if (hasBatch) {
    score += 0.04;
  }

  // Adjust slightly by OCR base quality if finite
  if (typeof ocrConfidence === "number" && Number.isFinite(ocrConfidence)) {
    if (ocrConfidence < 0.7) {
      score -= 0.15;
    }
  }

  // Clamp between 0.10 and 0.96
  const finalScore = Math.max(0.10, Math.min(0.96, score));
  return Math.round(finalScore * 100) / 100;
}

function isConfident(confidence) {
  return typeof confidence === "number" && confidence >= CONFIDENCE_THRESHOLD;
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  calculateConfidence,
  isConfident
};
