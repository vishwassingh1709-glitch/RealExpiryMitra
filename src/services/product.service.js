const productRepo = require("../repositories/product.repository");
const inventoryRepo = require("../repositories/inventory.repository");

const OFF_BASE =
  process.env.OPEN_FOOD_FACTS_BASE_URL ||
  "https://world.openfoodfacts.org/api/v2/product";

async function findProduct(barcode) {
  const normalizedBarcode = String(barcode || "").trim();

  if (!normalizedBarcode) return { status: "not_found" };

  console.log(`[API] Barcode lookup: ${normalizedBarcode}`);

  // 1. Check local/Firestore product repository
  const local = await productRepo.get(normalizedBarcode);

  // Check for existing inventory records for this barcode
  let invItem = null;
  try {
    invItem = await inventoryRepo.getByBarcode(normalizedBarcode);
  } catch (err) {
    console.warn(`[Inventory lookup warning]: ${err.message}`);
  }

  if (local) {
    const combined = {
      ...local,
      quantity: invItem?.quantity !== undefined ? invItem.quantity : (local.quantity !== undefined ? local.quantity : 1),
      expiryDate: invItem?.expiry_date || local.expiryDate || local.expiry_date || null,
      expiry_date: invItem?.expiry_date || local.expiry_date || local.expiryDate || null,
      batch: invItem?.batch || local.batch || null,
      inventory_id: invItem?.id || null
    };
    console.log(`[API] Product found: ${combined.name || combined.id}`);
    return { status: "found", product: combined };
  }

  // If not yet in product catalog, check if present in inventory records
  if (invItem) {
    const productFromInv = {
      id: invItem.id,
      barcode: normalizedBarcode,
      name: invItem.product_name || "Unknown product",
      brand: invItem.brand || "",
      category: invItem.category || "Other",
      quantity: invItem.quantity || 1,
      expiryDate: invItem.expiry_date || null,
      expiry_date: invItem.expiry_date || null,
      batch: invItem.batch || null,
      inventory_id: invItem.id,
      source: invItem.source || "inventory"
    };
    console.log(`[API] Product found via inventory: ${productFromInv.name}`);
    return { status: "found", product: productFromInv };
  }

  // 2. Fallback to Open Food Facts
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(
      `${OFF_BASE}/${encodeURIComponent(normalizedBarcode)}.json`,
      { signal: controller.signal }
    );

    if (response.ok) {
      const data = await response.json();

      if (data.status === 1 && data.product) {
        const product = {
          barcode: normalizedBarcode,
          name: data.product.product_name || data.product.generic_name || "Unknown product",
          brand: data.product.brands || "",
          category: data.product.categories_hierarchy?.[0]?.replace(/^en:/, "") || data.product.categories || "Packaged Food",
          image_url: data.product.image_front_url || data.product.image_url || null,
          quantity: 1,
          expiryDate: null,
          expiry_date: null,
          batch: null,
          source: "external_api"
        };

        await productRepo.save(product);
        console.log(`[API] Product found via Open Food Facts: ${product.name}`);
        return { status: "found", product };
      }
    }
  } catch (error) {
    console.warn("Open Food Facts lookup unavailable:", error.message);
  } finally {
    clearTimeout(timeout);
  }

  console.log(`[API] Product not found for barcode: ${normalizedBarcode}`);
  return { status: "not_found" };
}

async function searchProducts(query) {
  return productRepo.search(query);
}

async function listProducts() {
  return productRepo.list();
}

async function getProduct(barcodeOrId) {
  return productRepo.get(barcodeOrId);
}

async function saveProduct(product) {
  return productRepo.save(product);
}

async function updateProduct(barcodeOrId, updates) {
  return productRepo.update(barcodeOrId, updates);
}

async function deleteProduct(barcodeOrId) {
  return productRepo.remove(barcodeOrId);
}

module.exports = {
  findProduct,
  searchProducts,
  listProducts,
  getProduct,
  saveProduct,
  updateProduct,
  deleteProduct
};
