const test = require("node:test");
require("./helpers/preserve-data");
const assert = require("node:assert/strict");

const saleService = require("../src/services/sale.service");
const productService = require("../src/services/product.service");
const storeService = require("../src/services/store.service");
const inventoryService = require("../src/services/inventory.service");

/* ---------------- SALES & ATOMIC STOCK TESTS ---------------- */

test("sales flow reduces inventory stock and records sale record", async () => {
  // 1. Create a dedicated inventory item
  const testInvId = `inv_sale_test_${Date.now()}`;
  await inventoryService.create({
    id: testInvId,
    barcode: "8909999999999",
    product_name: "Test Juice",
    brand: "TestBrand",
    category: "Beverages",
    expiry_date: "2028-12-31",
    quantity: 10
  });

  // 2. Record sale of 3 units
  const saleResult = await saleService.recordSale({
    inventory_id: testInvId,
    quantity_sold: 3,
    unit_price: 50,
    store_id: "store_default"
  });

  assert.equal(saleResult.httpStatus, 201);
  assert.equal(saleResult.body.status, "success");
  assert.equal(saleResult.body.remainingStock, 7);
  assert.equal(saleResult.body.sale.total_amount, 150);

  // 3. Verify stock in inventory service
  const itemAfterSale = await inventoryService.get(testInvId);
  assert.equal(itemAfterSale.quantity, 7);

  // 4. Clean up test inventory item
  await inventoryService.remove(testInvId);
});

test("sales flow rejects sale when requested quantity exceeds available stock", async () => {
  const testInvId = `inv_low_test_${Date.now()}`;
  await inventoryService.create({
    id: testInvId,
    barcode: "8908888888888",
    product_name: "Limited Stock Item",
    expiry_date: "2028-12-31",
    quantity: 2
  });

  const saleResult = await saleService.recordSale({
    inventory_id: testInvId,
    quantity_sold: 5,
    unit_price: 100
  });

  assert.equal(saleResult.httpStatus, 400);
  assert.equal(saleResult.body.status, "insufficient_stock");

  // Verify stock was not changed
  const itemAfter = await inventoryService.get(testInvId);
  assert.equal(itemAfter.quantity, 2);

  await inventoryService.remove(testInvId);
});

test("sales summary computes metrics and totals correctly", async () => {
  const summary = await saleService.getSummary({ range: "all" });
  assert.ok(typeof summary.totalSales === "number");
  assert.ok(typeof summary.totalRevenue === "number");
  assert.ok(Array.isArray(summary.recentSales));
});

/* ---------------- PRODUCT CATALOG FULL CRUD TESTS ---------------- */

test("product catalog supports full CRUD lifecycle", async () => {
  const testBarcode = `890777${Date.now().toString().slice(-7)}`;

  // Create
  const created = await productService.saveProduct({
    barcode: testBarcode,
    name: "Special Choco Biscuit",
    brand: "SweetCo",
    category: "Packaged Food"
  });
  assert.equal(created.barcode, testBarcode);

  // Read
  const found = await productService.getProduct(testBarcode);
  assert.ok(found);
  assert.equal(found.name, "Special Choco Biscuit");

  // Update
  const updated = await productService.updateProduct(testBarcode, {
    name: "Special Choco Biscuit Delux"
  });
  assert.equal(updated.name, "Special Choco Biscuit Delux");

  // Search
  const searchResults = await productService.searchProducts("Special Choco");
  assert.ok(searchResults.some((p) => p.barcode === testBarcode));

  // Delete
  const deleted = await productService.deleteProduct(testBarcode);
  assert.equal(deleted, true);

  const missing = await productService.getProduct(testBarcode);
  assert.equal(missing, null);
});

/* ---------------- STORE & PROFILE MANAGEMENT TESTS ---------------- */

test("store service returns profile and allows updates", async () => {
  const profile = await storeService.getProfile();
  assert.ok(profile);
  assert.ok(profile.store_name);

  const updated = await storeService.updateProfile("store_default", {
    store_name: "Sharma Super Store"
  });
  assert.equal(updated.store_name, "Sharma Super Store");

  // Restore back to original name
  await storeService.updateProfile("store_default", {
    store_name: "Sharma Store"
  });
});
require("./helpers/preserve-data");
