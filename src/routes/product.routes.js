const express = require("express");
const productService = require("../services/product.service");

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
    const barcode = String(rawBarcode).trim();
    const result = await productService.findProduct(barcode);
    if (result.status === "found" && result.product) {
      return res.json({
        success: true,
        status: "found",
        product: result.product
      });
    }
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
    const barcode = String(rawBarcode).trim();
    const result = await productService.findProduct(barcode);
    if (result.status === "found" && result.product) {
      return res.json({
        success: true,
        status: "found",
        product: result.product
      });
    }
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
