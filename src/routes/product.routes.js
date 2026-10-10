const express = require("express");
const productService = require("../services/product.service");
const { normalizeBarcode, extractGs1Gtin } = require("../utils/barcode");

const router = express.Router();

// List all products in catalog
router.get("/", async (_req, res, next) => {
  try {
    const products = await productService.listProducts();
    return res.json(products);
  } catch (error) {
    next(error);
  }
});

// Barcode lookup (GET)
router.post("/identify", async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.body?.barcode);
    if (!barcode) return res.status(400).json({ success: false, status: "invalid", message: "A valid barcode is required" });
    const image = req.body?.image ?? null;
    if (image !== null && (typeof image !== "string" || image.length > 10 * 1024 * 1024)) {
      return res.status(413).json({ success: false, status: "invalid_image", message: "Product photo must be under 10 MB" });
    }
    const result = await productService.identifyProduct(barcode, req.user.store_id, image);
    const normalized_barcode = extractGs1Gtin(barcode) || barcode;
    if (result.status === "found" || result.status === "conflict") return res.json({ success: true, normalized_barcode, ...result });
    if (result.status === "unavailable") return res.status(503).json({ success: false, normalized_barcode, ...result, message: "Product lookup is temporarily unavailable" });
    if (result.status === "invalid_image") return res.status(400).json({ success: false, normalized_barcode, ...result, message: "Product photo format is not supported" });
    if (result.status === "invalid") return res.status(400).json({ success: false, normalized_barcode, ...result, message: "Barcode format is invalid" });
    return res.status(404).json({ success: false, normalized_barcode, ...result, message: "Product not found" });
  } catch (error) { next(error); }
});

router.get("/barcode/:barcode", async (req, res, next) => {
  try {
    const rawBarcode = req.params.barcode;
    if (!rawBarcode || typeof rawBarcode !== "string" || !rawBarcode.trim()) {
      return res.status(400).json({
        success: false,
        status: "error",
        message: "Valid barcode is required"
      });
    }
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) return res.status(400).json({ success: false, status: "invalid", message: "Barcode format is invalid" });
    const result = await productService.findProduct(barcode, req.user.store_id);
    if (result.status === "found" && result.product) {
      return res.json({
        success: true,
        status: "found",
        product: result.product
      });
    }
    if (result.status === "unavailable") {
      return res.status(503).json({
        success: false,
        status: "unavailable",
        message: "Product lookup is temporarily unavailable. Enter the product details manually."
      });
    }
    if (result.status === "invalid") return res.status(400).json({ success: false, status: "invalid", message: "Barcode format is invalid" });
    return res.status(404).json({
      success: false,
      status: "not_found",
      message: "Product not found"
    });
  } catch (error) {
    next(error);
  }
});

// Barcode lookup (POST)
router.post("/barcode", async (req, res, next) => {
  try {
    const rawBarcode = req.body?.barcode;
    if (!rawBarcode || typeof rawBarcode !== "string" || !rawBarcode.trim()) {
      return res.status(400).json({
        success: false,
        status: "error",
        message: "Valid barcode is required"
      });
    }
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) return res.status(400).json({ success: false, status: "invalid", message: "Barcode format is invalid" });
    const result = await productService.findProduct(barcode, req.user.store_id);
    if (result.status === "found" && result.product) {
      return res.json({
        success: true,
        status: "found",
        product: result.product
      });
    }
    if (result.status === "unavailable") {
      return res.status(503).json({
        success: false,
        status: "unavailable",
        message: "Product lookup is temporarily unavailable. Enter the product details manually."
      });
    }
    if (result.status === "invalid") return res.status(400).json({ success: false, status: "invalid", message: "Barcode format is invalid" });
    return res.status(404).json({
      success: false,
      status: "not_found",
      message: "Product not found"
    });
  } catch (error) {
    next(error);
  }
});

// Search products by name/barcode/brand
router.get("/search", async (req, res, next) => {
  try {
    const query = req.query.q || req.query.query || "";
    const results = await productService.searchProducts(query);
    return res.json(results);
  } catch (error) {
    next(error);
  }
});

// Get single product by id or barcode
router.get("/:id", async (req, res, next) => {
  try {
    const product = await productService.getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({ status: "not_found", message: "Product not found" });
    }
    return res.json(product);
  } catch (error) {
    next(error);
  }
});

// Add new product to catalog
router.post("/", async (req, res, next) => {
  try {
    const { barcode, name, brand, category, image_url } = req.body || {};
    if (!barcode || !name) {
      return res.status(400).json({
        status: "error",
        message: "barcode and name are required"
      });
    }
    const saved = await productService.saveProduct({ barcode, name, brand, category, image_url });
    return res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
});

// Update product
router.put("/:id", async (req, res, next) => {
  try {
    const updated = await productService.updateProduct(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ status: "not_found", message: "Product not found" });
    }
    return res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Delete product
router.delete("/:id", async (req, res, next) => {
  try {
    const success = await productService.deleteProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ status: "not_found", message: "Product not found" });
    }
    return res.json({ status: "success", message: "Product deleted from catalog" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
