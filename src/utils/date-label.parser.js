const { parseDate } = require("./date.parser");
const { addMonthsToDate, addDaysToDate } = require("./date.parser");

const LABELS = [
  { type: "manufacturing_date", regex: /\b(?:MFG|MFD|MANUFACTURING\s+DATE|MANUFACTURED(?:\s+ON)?|DATE\s+OF\s+(?:MFG|MANUFACTURE))\b/i, expiry: false },
  { type: "packaging_date", regex: /\b(?:PKD|PACKED(?:\s+ON)?|PACKAGING\s+DATE)\b/i, expiry: false },
  { type: "expiry_date", regex: /\b(?:EXP|EXPIRY|EXPIRATION(?:\s+DATE)?|EXPIRES\s+ON|USE\s+BY|USE\s+BEFORE)\b/i, expiry: true },
  { type: "best_before_date", regex: /\b(?:BEST\s+BEFORE|BEST\s+BY)\b/i, expiry: true },
  { type: "batch_number", regex: /\b(?:BATCH|LOT|B\.?NO|BN)\b/i, expiry: false }
];
const DATE_TOKEN = /(?:\b\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4}\b|\b\d{1,2}\s*[/.\-]\s*\d{2,4}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b)/i;

function parseOne(raw, type, source = "ocr") {
  const value = String(raw || "").trim().replace(/\s+/g, " ");
  if (!value) return null;
  const monthYear = /^(\d{1,2})\s*[/.\-]\s*(\d{2,4})$/.exec(value);
  const monthNameYear = /^([A-Za-z]{3,9})\s+(\d{2,4})$/.exec(value);
  if (monthYear || monthNameYear) {
    const parsed = parseDate(value, { isExpiry: true });
    if (!parsed) return { date_type: type, raw_value: value, normalized_date: null, precision: "month", source, uncertain: true, reason: "Invalid month/year date" };
    const [year, month] = parsed.split("-");
    return { date_type: type, raw_value: value, normalized_date: `${year}-${month}`, precision: "month", source, uncertain: false };
  }
  const numeric = /^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})$/.exec(value);
  if (numeric && Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12) {
    return { date_type: type, raw_value: value, normalized_date: null, precision: "day", source, uncertain: true, reason: "Ambiguous numeric day/month order" };
  }
  const normalized = parseDate(value, { isExpiry: type === "expiry_date" || type === "best_before_date" });
  if (!normalized) return { date_type: type, raw_value: value, normalized_date: null, precision: "day", source, uncertain: true, reason: "Unrecognized or invalid date" };
  return { date_type: type, raw_value: value, normalized_date: normalized, precision: "day", source, uncertain: false };
}

function parseDateLabelText(text, source = "ocr") {
  if (typeof text !== "string" || !text.trim()) return { candidates: [], raw_visible_text: "" };
  const candidates = [];
  const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of LABELS) {
      const match = label.regex.exec(line);
      if (!match) continue;
      const after = line.slice(match.index + match[0].length).replace(/^[\s:=.#-]+/, "");
      if (label.type === "batch_number") {
        const batchText = after.replace(/^(?:NO\.?|NUMBER)\b[\s:=.#-]*/i, "");
        const batch = /^[A-Z0-9][A-Z0-9/_-]{1,24}/i.exec(batchText);
        if (batch) candidates.push({ date_type: label.type, raw_value: batch[0], normalized_date: null, precision: null, source, uncertain: false });
        continue;
      }
      let dateMatch = DATE_TOKEN.exec(after);
      if (!dateMatch && !after && lines[i + 1]) dateMatch = DATE_TOKEN.exec(lines[i + 1]);
      if (dateMatch) candidates.push(parseOne(dateMatch[0], label.type, source));
    }
  }
  // Do not infer EXP from an unlabeled number/date. Preserve duration text for review without calculating it.
  const relative = text.match(/\b(?:BEST\s+BEFORE|USE\s+WITHIN|CONSUME\s+WITHIN)\b[^\n]{0,80}\b\d{1,3}\s*(?:MONTHS?|DAYS?|WEEKS?)\b[^\n]*/i);
  if (relative) {
    const rawValue = relative[0].trim();
    candidates.push({ date_type: "best_before_duration", raw_value: rawValue, normalized_date: null, precision: null, source, uncertain: true, derived: false, reason: "Printed duration retained as label text" });
    const relation = /\b(\d{1,3})\s*(MONTHS?|DAYS?|WEEKS?)\b[^\n]{0,50}\bFROM\s+(?:THE\s+)?(MFG|MFD|MANUFACTURE|MANUFACTURED|MANUFACTURING|PKD|PACKED|PACKAGING)(?:\s+DATE)?\b/i.exec(rawValue);
    if (relation) {
      const startType = /^(?:PKD|PACKED|PACKAGING)$/i.test(relation[3]) ? "packaging_date" : "manufacturing_date";
      const starts = candidates.filter((candidate) => candidate.date_type === startType && candidate.normalized_date && candidate.precision === "day" && !candidate.uncertain && !candidate.conflict);
      const uniqueStarts = [...new Set(starts.map((candidate) => candidate.normalized_date))];
      if (uniqueStarts.length === 1) {
        const count = Number(relation[1]);
        const unit = relation[2].toUpperCase();
        const normalized = unit.startsWith("MONTH") ? addMonthsToDate(uniqueStarts[0], count) : addDaysToDate(uniqueStarts[0], count * (unit.startsWith("WEEK") ? 7 : 1));
        if (normalized) candidates.push({ date_type: "best_before_date", raw_value: rawValue, normalized_date: normalized, precision: "day", source: "derived_from_label", uncertain: true, derived: true, reason: `Calculated from the printed duration and exact ${startType === "manufacturing_date" ? "manufacturing" : "packaging"} date; confirm manually` });
      }
    }
  }
  return { candidates, raw_visible_text: text };
}

function normalizeGeminiFields(fields = {}, rawText = "") {
  const output = [];
  for (const type of ["manufacturing_date", "packaging_date", "expiry_date", "best_before_date"]) {
    const value = fields[type];
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = parseOne(value, type, "gemini_image");
    if (candidate) candidate.uncertain = true; // Model readings are proposals until the shopkeeper confirms the label.
    output.push(candidate);
  }
  if (typeof fields.batch_number === "string" && fields.batch_number.trim()) {
    output.push({ date_type: "batch_number", raw_value: fields.batch_number.trim().slice(0, 64), normalized_date: null, precision: null, source: "gemini_image", uncertain: true });
  }
  const uncertain = Array.isArray(fields.uncertain_fields) ? fields.uncertain_fields.map(String) : [];
  for (const candidate of output) if (uncertain.includes(candidate.date_type)) candidate.uncertain = true;
  return { candidates: output, raw_visible_text: typeof fields.raw_visible_text === "string" ? fields.raw_visible_text.slice(0, 1000) : rawText, uncertain_fields: uncertain };
}

module.exports = { parseDateLabelText, parseOne, normalizeGeminiFields };
