/**
 * Business validation service for date logic and confidence thresholds.
 */

const { isValidDateParts, isLeapYear } = require("../utils/date.parser");
const { CONFIDENCE_THRESHOLD } = require("../utils/confidence");

const THRESHOLD = CONFIDENCE_THRESHOLD;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  return isValidDateParts(year, month, day);
}

function validate(result) {
  if (!result || typeof result !== "object") {
    return {
      accepted: false,
      reason: "low_confidence",
      message: "Expiry information could not be verified. Please retry or enter manually."
    };
  }

  // 1. Check for chronological order violation first
  if (result.mfg_date && result.expiry_date && result.expiry_date < result.mfg_date) {
    return {
      accepted: false,
      reason: "invalid",
      message: "Expiry date cannot be earlier than manufacturing date."
    };
  }

  // 2. Validate expiry date existence and format
  if (!validDate(result.expiry_date)) {
    return {
      accepted: false,
      reason: "low_confidence",
      message: "Expiry date could not be parsed reliably."
    };
  }

  // 3. Validate manufacturing date format if present
  if (result.mfg_date && !validDate(result.mfg_date)) {
    return {
      accepted: false,
      reason: "invalid",
      message: "Manufacturing date is invalid."
    };
  }

  // 4. Validate confidence score against locked 0.75 threshold
  if (typeof result.confidence !== "number" || result.confidence < THRESHOLD) {
    return {
      accepted: false,
      reason: "low_confidence",
      message: "Expiry information could not be verified. Please retry or enter manually."
    };
  }

  return {
    accepted: true,
    reason: "confident",
    message: "Validated successfully"
  };
}

module.exports = {
  validate,
  validDate,
  THRESHOLD,
  isLeapYear
};