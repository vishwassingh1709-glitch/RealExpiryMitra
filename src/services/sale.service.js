/**
 * Sales service managing product sales transactions and revenue metrics.
 */

const saleRepo = require("../repositories/sale.repository");
const inventoryRepo = require("../repositories/inventory.repository");

/**
 * Records a new sale.
 * Validates stock availability, prevents negative inventory and duplicate submissions.
 */
async function recordSale(payload = {}) {
  const inventory_id = String(payload.inventory_id || "").trim();
  const quantity = Math.floor(Number(payload.quantity_sold || payload.quantity || 1));
  const unit_price = Number(payload.unit_price) >= 0 ? Number(payload.unit_price) : 0;
  const store_id = payload.store_id || "store_default";
  const notes = payload.notes || "";

  if (!inventory_id) {
    return {
      httpStatus: 400,
      body: { status: "error", message: "inventory_id is required" }
    };
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      httpStatus: 400,
      body: { status: "error", message: "quantity_sold must be a positive integer" }
    };
  }

  // Pre-check inventory existence
  const inventoryItem = await inventoryRepo.get(inventory_id);
  if (!inventoryItem) {
    return {
      httpStatus: 404,
      body: { status: "not_found", message: "Inventory item not found" }
    };
  }

  if (inventoryItem.quantity < quantity) {
    return {
      httpStatus: 400,
      body: {
        status: "insufficient_stock",
        message: `Cannot sell ${quantity} units. Only ${inventoryItem.quantity} units available in stock.`
      }
    };
  }

  try {
    const result = await saleRepo.recordSale({
      inventory_id,
      quantity_sold: quantity,
      unit_price,
      store_id,
      notes
    });

    return {
      httpStatus: 201,
      body: {
        status: "success",
        message: `Sale recorded successfully for ${result.sale.product_name} (${quantity} units)`,
        sale: result.sale,
        remainingStock: result.updatedInventory.quantity
      }
    };
  } catch (error) {
    return {
      httpStatus: 400,
      body: { status: "error", message: error.message }
    };
  }
}

/**
 * Lists sales transactions.
 */
async function listSales(options = {}) {
  return saleRepo.listSales(options);
}

/**
 * Gets sales summary dashboard statistics.
 */
async function getSummary(options = {}) {
  return saleRepo.getSalesSummary(options);
}

module.exports = {
  recordSale,
  listSales,
  getSummary
};
