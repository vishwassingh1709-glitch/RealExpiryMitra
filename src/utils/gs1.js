const { getDaysInMonth, isValidDateParts } = require("./date.parser");
const { hasValidGs1CheckDigit } = require("./barcode");

const DATE_AIS = { "11": "manufacturing_date", "13": "packaging_date", "15": "best_before_date", "17": "expiry_date" };

function gs1Year(twoDigits, nowYear = new Date().getFullYear()) {
  const year = Number(twoDigits);
  const base = Math.floor(nowYear / 100) * 100 + year;
  const options = [base - 100, base, base + 100].filter((candidate) => candidate >= nowYear - 49 && candidate <= nowYear + 50);
  return options.length === 1 ? options[0] : null;
}

function makeDate(value, ai) {
  if (!/^\d{6}$/.test(value)) return null;
  const year = gs1Year(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const encodedDay = Number(value.slice(4, 6));
  if (!year || month < 1 || month > 12 || encodedDay > 31) return null;
  // GS1 defines day 00 as the last calendar day of the encoded month (including leap years).
  const day = encodedDay || getDaysInMonth(year, month);
  if (!isValidDateParts(year, month, day)) return null;
  return {
    date_type: DATE_AIS[ai],
    raw_value: value,
    normalized_date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    precision: encodedDay ? "day" : "month",
    date_convention: encodedDay ? null : "gs1_day_00_end_of_month",
    source: "gs1_barcode",
    verified: true,
    ai
  };
}

function parseParenthesized(input) {
  const values = [];
  const tokens = [...input.matchAll(/\((\d{2,4})\)([^()]*)/g)];
  const gtin = tokens.find((token) => token[1] === "01")?.[2].trim();
  if (gtin && !hasValidGs1CheckDigit(gtin)) return [];
  for (const token of tokens) {
    const ai = token[1];
    const value = token[2].trim();
    if (DATE_AIS[ai]) {
      const candidate = makeDate(value.slice(0, 6), ai);
      if (candidate) values.push(candidate);
    } else if (ai === "10" && value) {
      values.push({ date_type: "batch_number", raw_value: value, normalized_date: null, precision: null, source: "gs1_barcode", verified: true, ai });
    }
  }
  return values;
}

function parseGs1Barcode(value) {
  if (typeof value !== "string") return [];
  const input = value.trim().replace(/^\](?:C1|d2|Q3)/i, "");
  if (!input) return [];
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() !== "id.gs1.org") return [];
      const fields = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const pairs = [];
      for (let index = 0; index + 1 < fields.length; index += 2) pairs.push(`(${fields[index]})${fields[index + 1]}`);
      for (const [ai, field] of url.searchParams) if (/^(?:10|11|13|15|17)$/.test(ai)) pairs.push(`(${ai})${field}`);
      return parseParenthesized(pairs.join(""));
    } catch (_) { return []; }
  }
  if (input.includes("(")) return parseParenthesized(input);

  const elements = input.split("\u001d");
  const output = [];
  for (const element of elements) {
    let index = 0;
    while (index < element.length) {
      const ai = element.slice(index, index + 2);
      if (DATE_AIS[ai]) {
        const valuePart = element.slice(index + 2, index + 8);
        if (valuePart.length !== 6 || !/^\d{6}$/.test(valuePart)) break;
        const date = makeDate(valuePart, ai);
        if (date) output.push(date);
        index += 8;
      } else if (ai === "10") {
        const batch = element.slice(index + 2).trim();
        if (batch) output.push({ date_type: "batch_number", raw_value: batch, normalized_date: null, precision: null, source: "gs1_barcode", verified: true, ai });
        break;
      } else if (ai === "01" && hasValidGs1CheckDigit(element.slice(index + 2, index + 16))) {
        index += 16; // GTIN only; it is not a date.
      } else if (ai === "00" && /^\d{18}$/.test(element.slice(index + 2, index + 20))) {
        index += 20; // SSCC only; it is not a date.
      } else {
        break;
      }
    }
  }
  return output;
}

module.exports = { parseGs1Barcode, gs1Year };
