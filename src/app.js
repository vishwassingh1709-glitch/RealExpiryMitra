const express = require("express");
const cors = require("cors");
const path = require("path");

const scanRoutes = require("./routes/scan.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const productRoutes = require("./routes/product.routes");
const categoryRoutes = require("./routes/category.routes");
const saleRoutes = require("./routes/sale.routes");
const storeRoutes = require("./routes/store.routes");
const { optionalAuth } = require("./middleware/auth.middleware");
const { getFirestoreStatus } = require("./repositories/firestore");
const { isFirestoreActive } = require("./repositories/inventory.repository");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(cors());
// Permissive body parser for camera and image file uploads (up to 12MB)
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(optionalAuth);

// Serve modern frontend
app.use(express.static(path.join(__dirname, "../public")));

function getHealthStatus() {
  const firestoreStatus = getFirestoreStatus();
  const storageProvider = isFirestoreActive() ? "firestore" : "json";
  const ocrProvider = process.env.OCR_PROVIDER || (process.env.OCR_API_KEY ? "ocr_space" : "tesseract");
  const aiProvider = process.env.GEMINI_API_KEY ? "google_gemini" : "deterministic_rules";

  return {
    status: "ok",
    service: "expirymitra",
    storage: {
      activeProvider: storageProvider,
      firestore: firestoreStatus
    },
    ocr: {
      activeProvider: ocrProvider,
      tesseractAvailable: true,
      ocrSpaceConfigured: Boolean(process.env.OCR_API_KEY)
    },
    ai: {
      activeProvider: aiProvider,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash"
    },
    uptime: process.uptime()
  };
}

app.get("/health", (_req, res) => {
  res.json(getHealthStatus());
});

app.get("/api/health", (_req, res) => {
  res.json(getHealthStatus());
});

app.use("/api", scanRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/store", storeRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
