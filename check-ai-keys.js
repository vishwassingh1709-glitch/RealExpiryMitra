require("dotenv").config();

const fetch = globalThis.fetch;

function safeMessage(data) {
  let message =
    data?.error?.message ||
    data?.error?.type ||
    "Unknown API error";

  return String(message)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(/gsk_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;

  console.log("\n--- GEMINI CHECK ---");

  if (!key) {
    console.log("FAIL: GEMINI_API_KEY is missing from .env");
    return;
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(10000),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.log(`FAIL: HTTP ${response.status}`);
      console.log(safeMessage(data));
      return;
    }

    const models = data.models || [];
    const configuredModel = (
      process.env.GEMINI_MODEL || "gemini-1.5-flash"
    ).replace(/^models\//, "");

    const match = models.find(
      model => model.name?.replace(/^models\//, "") === configuredModel
    );

    console.log("PASS: Gemini API key accepted");
    console.log("Configured model:", configuredModel);

    if (
      match &&
      match.supportedGenerationMethods?.includes("generateContent")
    ) {
      console.log("PASS: Model supports generateContent");
    } else {
      console.log("WARNING: Configured model is unavailable or");
      console.log("does not list generateContent as supported.");

      console.log(
        "Available text-generation models:",
        models
          .filter(model =>
            model.supportedGenerationMethods?.includes("generateContent")
          )
          .map(model => model.name)
          .slice(0, 10)
          .join(", ")
      );
    }
  } catch (error) {
    console.log("FAIL: Gemini request could not complete");
    console.log(error.name || "Network error");
  }
}

async function checkGroq() {
  const key = process.env.GROQ_API_KEY;

  console.log("\n--- GROQ CHECK ---");

  if (!key) {
    console.log("FAIL: GROQ_API_KEY is missing from .env");
    return;
  }

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/models",
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.log(`FAIL: HTTP ${response.status}`);
      console.log(safeMessage(data));
      return;
    }

    const models = data.data || [];
    const configuredModel =
      process.env.GROQ_MODEL || "openai/gpt-oss-20b";

    const match = models.find(model => model.id === configuredModel);

    console.log("PASS: Groq API key accepted");
    console.log("Configured model:", configuredModel);
    console.log(
      match
        ? "PASS: Model appears in available model list"
        : "WARNING: Configured model is not in the available list"
    );

    console.log(
      "Browser Search compatible:",
      [
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-safeguard-20b",
      ].includes(configuredModel)
        ? "model is on the documented compatibility list; tool use still needs testing"
        : "not on the documented Browser Search compatibility list"
    );
  } catch (error) {
    console.log("FAIL: Groq request could not complete");
    console.log(error.name || "Network error");
  }
}

async function main() {
  if (!fetch) {
    console.log("Use Node.js 18 or newer for this test.");
    process.exitCode = 1;
    return;
  }

  await checkGemini();
  await checkGroq();

  console.log("\nDiagnostic complete. No API keys were printed.");
}

main();