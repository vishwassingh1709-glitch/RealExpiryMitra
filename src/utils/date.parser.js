/**
 * Robust date parser and validator for product manufacturing and expiry dates.
 */

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year, month) {
  const daysMap = [
    31,
    isLeapYear(year) ? 29 : 28,
    31, 30, 31, 30,
    31, 31, 30, 31, 30, 31
  ];
  return daysMap[month - 1] || 0;
}

function isValidDateParts(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }

  if (year < 1970 || year > 2100) return false;
  if (month < 1 || month > 12) return false;

  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) return false;

  return true;
}

function formatIso(year, month, day) {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeYear(yy) {
  const num = Number(yy);
  if (num >= 1000) return num;
  // Two-digit year: 00..70 -> 2000s, 71..99 -> 1900s
  return num <= 70 ? 2000 + num : 1900 + num;
}

/**
 * Parses raw date string into YYYY-MM-DD.
 * @param {string} rawString
 * @param {object} [options]
 * @param {boolean} [options.isExpiry=true]
 * @returns {string|null} ISO date string or null if unparseable/ambiguous
 */
function parseDate(rawString, options = {}) {
  if (typeof rawString !== "string") return null;
  const str = rawString.trim();
  if (!str) return null;

  const isExpiry = options.isExpiry !== false;

  // 1. Format: DD-MMM-YYYY or DD MMM YYYY or DD/MMM/YYYY
  const textMonthMatch = str.match(
    /^(\d{1,2})[\s\-\/.]([A-Za-z]{3,9})[\s\-\/.](\d{2,4})$/
  );
  if (textMonthMatch) {
    const day = Number(textMonthMatch[1]);
    const monthKey = textMonthMatch[2].toLowerCase();
    const month = MONTH_NAMES[monthKey];
    const year = normalizeYear(textMonthMatch[3]);

    if (month && isValidDateParts(year, month, day)) {
      return formatIso(year, month, day);
    }
    return null;
  }

  // 2. Format: MMM YYYY or MMM-YYYY (e.g. AUG 2027)
  const monthNameYearMatch = str.match(
    /^([A-Za-z]{3,9})[\s\-\/.](\d{2,4})$/
  );
  if (monthNameYearMatch) {
    const monthKey = monthNameYearMatch[1].toLowerCase();
    const month = MONTH_NAMES[monthKey];
    const year = normalizeYear(monthNameYearMatch[2]);
    if (month && year >= 1970 && year <= 2100) {
      const day = isExpiry ? getDaysInMonth(year, month) : 1;
      return formatIso(year, month, day);
    }
  }

  // 3. Format: MM/YYYY or MM-YYYY or MM.YYYY (or 2-digit MM/YY)
  const monthYearMatch = str.match(/^(\d{1,2})[\/\-\.](\d{2,4})$/);
  if (monthYearMatch) {
    const month = Number(monthYearMatch[1]);
    const year = normalizeYear(monthYearMatch[2]);
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 2100) {
      const day = isExpiry ? getDaysInMonth(year, month) : 1;
      return formatIso(year, month, day);
    }
    return null;
  }

  // 4. Format: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY or 2-digit year DD/MM/YY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmyMatch) {
    const part1 = Number(dmyMatch[1]);
    const part2 = Number(dmyMatch[2]);
    const year = normalizeYear(dmyMatch[3]);

    const day = part1;
    const month = part2;

    if (isValidDateParts(year, month, day)) {
      return formatIso(year, month, day);
    }

    return null;
  }

  // 5. ISO format YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);

    if (isValidDateParts(year, month, day)) {
      return formatIso(year, month, day);
    }
    return null;
  }

  return null;
}

/**
 * Adds months to an ISO date string (YYYY-MM-DD) and returns the resulting ISO date string.
 * Used for "BEST BEFORE X MONTHS FROM MFG" rules.
 */
function addMonthsToDate(dateStr, monthsToAdd) {
  if (!dateStr || !monthsToAdd) return null;
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3) return null;

  let [year, month, day] = parts;
  month += Number(monthsToAdd);

  while (month > 12) {
    year += 1;
    month -= 12;
  }

  const maxDays = getDaysInMonth(year, month);
  if (day > maxDays) day = maxDays;

  return formatIso(year, month, day);
}

/**
 * Adds days to an ISO date string.
 */
function addDaysToDate(dateStr, daysToAdd) {
  if (!dateStr || !daysToAdd) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(daysToAdd));
  return d.toISOString().slice(0, 10);
}

module.exports = {
  parseDate,
  isValidDateParts,
  isLeapYear,
  getDaysInMonth,
  formatIso,
  addMonthsToDate,
  addDaysToDate,
  MONTH_NAMES
};
