
require("dotenv").config();

async function main() {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    console.log("FAIL: SERPER_API_KEY is missing from .env");
    return;
  }

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: "Maggi noodles India",
        gl: "in",
        hl: "en",
        num: 5,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (!response.ok) {
      console.log("Serper request failed:", response.status);
      console.log(
        data?.message || data?.error || "Check API key and account status."
      );
      return;
    }

    console.log("✅ Serper API request succeeded.");

    const results = data.organic || [];
    console.log("Results received:", results.length);

    results.slice(0, 3).forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.title}`);
      console.log(result.link);
    });
  } catch (error) {
    console.log("Serper request failed:", error.name);
    console.log("Check your internet connection and retry.");
  }
}

main();
