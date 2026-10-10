require("dotenv").config();

const app = require("./app");
const { initializeFirestore } = require("./repositories/firestore");

const PORT = Number(process.env.PORT || 3000);

// Initialize Firestore if credentials exist
initializeFirestore();

app.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log(`🌿 ExpiryMitra Server Running`);
  console.log(`🌐 Local URL:   http://localhost:${PORT}`);
  console.log(`📡 Storage:     ${process.env.STORAGE_PROVIDER || "auto (Firestore/JSON)"}`);
  console.log(`👁️  OCR Provider:${process.env.OCR_PROVIDER || (process.env.OCR_API_KEY ? "ocr_space" : "tesseract")}`);
  console.log(`🧠 AI Engine:   ${process.env.GEMINI_API_KEY ? "Google Gemini" : "Deterministic Parser"}`);
  console.log("==========================================");
});
