const storeService = require("../services/store.service");

async function getStore(req, res, next) {
  try {
    const storeId = req.query.store_id || req.user?.store_id || "store_default";
    const store = await storeService.getProfile(storeId);
    return res.json(store);
  } catch (error) {
    return next(error);
  }
}

async function updateStore(req, res, next) {
  try {
    const storeId = req.body?.store_id || req.user?.store_id || "store_default";
    const updated = await storeService.updateProfile(storeId, req.body || {});
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getStore,
  updateStore
};
