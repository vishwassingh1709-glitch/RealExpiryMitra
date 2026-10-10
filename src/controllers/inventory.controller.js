const service = require("../services/inventory.service");

async function listInventory(req, res, next) {
  try {
    const options = {
      search: req.query.search || req.query.q || undefined,
      category: req.query.category || undefined,
      status: req.query.status || undefined,
      sortBy: req.query.sort || req.query.sortBy || "created_desc",
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : 0
    };
    const items = await service.list(options, req.user.store_id);
    res.json(items);
  } catch (error) {
    next(error);
  }
}

async function getInventory(req, res, next) {
  try {
    const item = await service.get(req.params.id, req.user.store_id);
    if (!item) {
      return res.status(404).json({ status: "not_found", message: "Inventory item not found" });
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
}

async function createManual(req, res, next) {
  try {
    const result = await service.createManual(req.body || {}, req.user.store_id);
    res.status(result.httpStatus).json(result.body);
  } catch (error) {
    next(error);
  }
}

async function confirmSave(req, res, next) {
  try {
    const result = await service.confirmSave(req.body || {}, req.user.store_id);
    res.status(result.httpStatus).json(result.body);
  } catch (error) {
    next(error);
  }
}

async function deleteInventory(req, res, next) {
  try {
    const success = await service.remove(req.params.id, req.user.store_id);
    if (!success) {
      return res.status(404).json({ status: "not_found", message: "Item not found" });
    }
    res.json({ status: "success", message: "Item removed from inventory" });
  } catch (error) {
    next(error);
  }
}

async function updateInventory(req, res, next) {
  try {
    const item = await service.update(req.params.id, req.body || {}, req.user.store_id);
    if (!item) {
      return res.status(404).json({ status: "not_found", message: "Item not found" });
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
}

async function getSummary(req, res, next) {
  try {
    const summary = await service.getSummary(req.user.store_id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listInventory,
  getInventory,
  createManual,
  confirmSave,
  deleteInventory,
  updateInventory,
  getSummary
};
