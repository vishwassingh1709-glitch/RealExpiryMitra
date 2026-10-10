const storeService = require("../services/store.service");

async function getStore(req, res, next) {
  try {
    const storeId = req.user.store_id;
    const store = await storeService.getProfile(storeId);
    return res.json(store);
  } catch (error) {
    return next(error);
  }
}

async function updateStore(req, res, next) {
  try {
    const storeId = req.user.store_id;
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
