const DEFAULT_MODEL = "openai/gpt-oss-20b";
const SUPPORTED_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b"
]);
const inFlight = new Map();

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function parseJsonObject(text) {
  const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1])];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (_) {}
  }
  return null;
}

function parseLabeledText(text) {
  const aliases = {
    result: ["RESULT", "STATUS"],
    name: ["PRODUCT NAME", "NAME"],
    brand: ["BRAND"],
    package_size: ["PACKAGE SIZE", "SIZE"],
    matched_barcode: ["EXACT BARCODE", "MATCHED BARCODE", "BARCODE"],
    exact_barcode_match: ["EXACT MATCH", "EXACT BARCODE MATCH"],
    evidence: ["EVIDENCE", "SUPPORTING EVIDENCE"]
  };
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?([^:]+?)(?:\*\*)?\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const label = match[1].replace(/\*/g, "").trim().toUpperCase();
    const field = Object.keys(aliases).find((key) => aliases[key].includes(label));
    if (field && fields[field] === undefined) fields[field] = match[2].replace(/^['"`]|['"`]$/g, "").trim();
  }
  const urls = [...text.matchAll(/https?:\/\/[^\s<>\])}]+/gi)].map((match) => match[0].replace(/[.,;]+$/, ""));
  return {
    ...fields,
    exact_barcode_match: /^(?:yes|true|exact match)$/i.test(fields.exact_barcode_match || ""),
    source_urls: urls
  };
}

function asStrings(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function cleanSourceUrls(values) {
  const urls = [];
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:" && !url.username && !url.password && !urls.includes(url.toString())) urls.push(url.toString());
    } catch (_) {}
    if (urls.length >= 5) break;
  }
  return urls;
}

function parseBrowserSearchResponse(response, barcode) {
  const content = response?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
      : "";
  if (!text) return null;

  const structured = parseJsonObject(text);
  const labeled = parseLabeledText(text);
  const result = structured || labeled;
  const name = cleanText(result.product_name || result.name, 160);
  const matchedBarcode = cleanText(result.matched_barcode || result.barcode, 128);
  const evidence = cleanText(result.evidence || result.supporting_evidence, 700);
  const urlsInText = [...text.matchAll(/https?:\/\/[^\s<>\])}]+/gi)].map((match) => match[0].replace(/[.,;]+$/, ""));
  const citationUrls = (response.choices?.[0]?.message?.annotations || [])
    .map((annotation) => annotation?.url || annotation?.url_citation?.url)
    .filter((url) => typeof url === "string");
  const sourceUrls = cleanSourceUrls([
    ...asStrings(result.source_urls || result.sources),
    ...labeled.source_urls,
    ...urlsInText,
    ...citationUrls
  ]);
  const exactClaim = result.exact_barcode_match === true || labeled.exact_barcode_match || /\bexact(?:ly)?\s+(?:matches|match|barcode match)\b/i.test(text);
  const barcodePresent = matchedBarcode === barcode && text.includes(barcode);
  const resultLabel = cleanText(result.result || result.status, 32).toUpperCase();
  if (resultLabel === "NOT_FOUND" || resultLabel === "NO_MATCH") return { status: "not_found" };
  if (resultLabel === "UNCERTAIN") return { status: "not_found" };
  if (!resultLabel || !["MATCH", "FOUND"].includes(resultLabel)) return { status: "malformed_response" };
  if (!name || !barcodePresent || !exactClaim || !sourceUrls.length || !evidence || !evidence.includes(barcode)) {
    return { status: "not_found" };
  }

  return {
    status: "found",
    product: {
      barcode,
      name,
      brand: cleanText(result.brand, 100),
      package_size: cleanText(result.package_size || result.packageSize, 80),
      category: cleanText(result.category, 100),
      source: "groq_browser_search_candidate",
      source_label: "Groq web search suggestion",
      verification_status: "unverified",
      exact_barcode_match: true,
      evidence,
      source_urls: sourceUrls
    }
  };
}

function responseText(response) {
  const content = response?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join("\n") : "";
}

async function lookupUnshared(barcode, { fetchImpl = global.fetch } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { status: "not_configured" };

  const model = process.env.GROQ_BROWSER_SEARCH_MODEL || DEFAULT_MODEL;
  if (!SUPPORTED_MODELS.has(model)) return { status: "unsupported_model" };
  if (typeof fetchImpl !== "function") return { status: "unavailable" };

  const timeoutMs = Number(process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS) > 0
    ? Math.min(Number(process.env.GROQ_PRODUCT_LOOKUP_TIMEOUT_MS), 12000)
    : 6500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const prompt = `Identify a packaged retail product from this exact decoded barcode: ${barcode}. Use browser search to find sources that explicitly associate this exact barcode with a product. Prefer manufacturer pages, established retailers, and trustworthy product databases. Do not infer a match from similar names, package sizes, or neighboring barcodes. Return plain text (no markdown fence) with these labels: RESULT: MATCH, NOT_FOUND, or UNCERTAIN; PRODUCT NAME:; BRAND:; PACKAGE SIZE:; EXACT BARCODE: (copy only if a source explicitly shows the exact barcode); EXACT MATCH: YES or NO; EVIDENCE: a brief source-supported statement that includes the exact barcode and product name; SOURCE URLS: one or more literal https URLs of pages that support the association. If no source explicitly connects ${barcode} to the product, return RESULT: NOT_FOUND and do not guess. This result is only a candidate and requires shopkeeper confirmation.`;

  try {
    const response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 1,
        max_completion_tokens: 1000,
        top_p: 1,
        stream: false,
        reasoning_effort: "low",
        tool_choice: "required",
        tools: [{ type: "browser_search" }]
      })
    });
    if (response.status === 429) return { status: "rate_limited" };
    if (!response.ok) return { status: response.status === 400 ? "unsupported_model" : "unavailable" };
    let data;
    try { data = await response.json(); } catch (_) { return { status: "malformed_response" }; }
    const parsed = parseBrowserSearchResponse(data, barcode);
    return parsed || (responseText(data) ? { status: "not_found" } : { status: "malformed_response" });
  } catch (error) {
    return { status: error?.name === "AbortError" ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function lookupBarcodeOnWeb(barcode, options) {
  if (inFlight.has(barcode)) return inFlight.get(barcode);
  const task = lookupUnshared(barcode, options);
  inFlight.set(barcode, task);
  return task.finally(() => inFlight.delete(barcode));
}

module.exports = { lookupBarcodeOnWeb, parseBrowserSearchResponse, DEFAULT_MODEL };
