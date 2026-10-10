"use strict";

function normalizeBarcode(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const barcode = String(value).trim();
  // GS1 element strings use ASCII 29 (FNC1) as a variable-field separator.
  if (!barcode || barcode.length > 128 || /[\u0000-\u001c\u001e-\u001f\u007f]/.test(barcode)) return "";
  return barcode;
}

function hasValidGs1CheckDigit(value) {
  const digits = String(value);
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 2; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

function extractGs1Gtin(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const parenthesized = /\(01\)(\d{14})/.exec(input);
  if (parenthesized && hasValidGs1CheckDigit(parenthesized[1])) return parenthesized[1];
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() === "id.gs1.org") {
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        for (let index = 0; index < segments.length - 1; index += 1) {
          if (segments[index] === "01" && /^\d{14}$/.test(segments[index + 1]) && hasValidGs1CheckDigit(segments[index + 1])) return segments[index + 1];
        }
      }
    } catch (_) { return null; }
  }
  const raw = input.replace(/^\](?:C1|d2|Q3)/i, "");
  const element = /(?:^|\u001d)01(\d{14})(?=(?:11|13|15|17|10|\u001d|$))/.exec(raw);
  return element && hasValidGs1CheckDigit(element[1]) ? element[1] : null;
}

function expandUpce(value) {
  if (!/^\d{8}$/.test(value) || !["0", "1"].includes(value[0])) return null;
  const ns = value[0];
  const d = value.slice(1, 7);
  let body;
  if ("012".includes(d[5])) body = `${ns}${d.slice(0, 2)}${d[5]}0000${d.slice(2, 5)}`;
  else if (d[5] === "3") body = `${ns}${d.slice(0, 3)}00000${d.slice(3, 5)}`;
  else if (d[5] === "4") body = `${ns}${d.slice(0, 4)}00000${d[4]}`;
  else body = `${ns}${d.slice(0, 5)}0000${d[5]}`;
  const expanded = body + value[7];
  return hasValidGs1CheckDigit(expanded) ? expanded : null;
}

function barcodeCandidates(value) {
  const barcode = normalizeBarcode(value);
  const candidates = new Set(barcode ? [barcode] : []);
  if (/^\d{12}$/.test(barcode) && hasValidGs1CheckDigit(barcode)) candidates.add(`0${barcode}`);
  if (/^0\d{12}$/.test(barcode) && hasValidGs1CheckDigit(barcode)) candidates.add(barcode.slice(1));
  if (/^0\d{13}$/.test(barcode) && hasValidGs1CheckDigit(barcode)) candidates.add(barcode.slice(1));
  const upca = /^\d{8}$/.test(barcode) ? expandUpce(barcode) : null;
  if (upca) {
    candidates.add(upca);
    candidates.add(`0${upca}`);
  }
  return [...candidates];
}

function isRetailGtin(value) {
  const barcode = normalizeBarcode(value);
  if (!/^\d+$/.test(barcode)) return false;
  if (barcode.length === 8) return Boolean(expandUpce(barcode)) || hasValidGs1CheckDigit(barcode);
  return hasValidGs1CheckDigit(barcode);
}

function canonicalBarcode(value) {
  const barcode = normalizeBarcode(value);
  if (/^\d{12}$/.test(barcode) && hasValidGs1CheckDigit(barcode)) return `0${barcode}`;
  const expanded = /^\d{8}$/.test(barcode) ? expandUpce(barcode) : null;
  return expanded ? `0${expanded}` : barcode;
}

module.exports = { normalizeBarcode, hasValidGs1CheckDigit, extractGs1Gtin, barcodeCandidates, isRetailGtin, canonicalBarcode };
