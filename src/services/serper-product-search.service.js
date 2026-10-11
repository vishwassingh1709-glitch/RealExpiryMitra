const inFlight = new Map();

function timeoutMs() {
  const configured = Number(process.env.SERPER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3500;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function includesExactBarcode(text, barcode) {
  const escaped = barcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(String(text || ""));
}

async function lookupBarcodeOnGoogle(barcode) {
  const code = String(barcode ?? "").trim().replace(/\s+/g, "");
  const apiKey = process.env.SERPER_API_KEY;

  if (!code) return { status: "invalid" };
  if (!apiKey) {
    console.warn("[Serper] API key is not configured");
    return { status: "unavailable" };
  }

  if (inFlight.has(code)) return inFlight.get(code);

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());

    try {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          q: `"${code}" product barcode`,
          gl: "in",
          hl: "en",
          num: 10,
        }),
        signal: controller.signal,
      });

      if (response.status === 429) return { status: "rate_limited" };
      if (response.status === 401 || response.status === 403) {
        console.warn("[Serper] API authentication/configuration failed");
        return { status: "unavailable" };
      }
      if (!response.ok) {
        console.warn("[Serper] Search request failed:", response.status);
        return { status: "unavailable" };
      }

      let data;
      try {
        data = await response.json();
      } catch {
        return { status: "malformed_response" };
      }

      const results = (Array.isArray(data.organic) ? data.organic : [])
        .map((item) => ({
          title: String(item.title || "").trim(),
          url: safeHttpsUrl(item.link),
          snippet: String(item.snippet || "").trim(),
        }))
        .filter((item) => item.title && item.url);

      if (!results.length) return { status: "not_found" };

      const exactMatch = results.find((item) =>
        includesExactBarcode(`${item.title} ${item.snippet}`, code)
      );

      // A result without an explicit barcode mention is only a candidate.
      // Keep searching with later fallbacks before using it in the UI.
      const selected = exactMatch || results[0];
      const sources = results.slice(0, 3).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        barcodeMentioned: includesExactBarcode(
          `${item.title} ${item.snippet}`,
          code
        ),
      }));

      console.info("[Serper] Search completed", {
        barcode: code,
        resultCount: results.length,
        explicitBarcodeMatch: Boolean(exactMatch),
      });

      return {
        status: exactMatch ? "found" : "candidate",
        product: {
          barcode: code,
          name: selected.title,
          brand: "",
          category: "",
          image_url: null,
          source: "serper_google_search",
          source_label: "Google Search via Serper",
          verification_status: "unverified",
          requires_confirmation: true,
          source_url: selected.url,
          evidence: selected.snippet,
          barcode_mentioned: Boolean(exactMatch),
          sources,
        },
      };
    } catch (error) {
      console.warn(
        "[Serper] Search unavailable:",
        error.name === "AbortError" ? "request timed out" : "network error"
      );
      return { status: error.name === "AbortError" ? "timeout" : "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  })();

  inFlight.set(code, task);
  try {
    return await task;
  } finally {
    inFlight.delete(code);
  }
}

module.exports = { lookupBarcodeOnGoogle };
