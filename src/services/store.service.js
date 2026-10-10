const storeRepo = require("../repositories/store.repository");

async function getProfile(storeId = "store_default") {
  return storeRepo.getStore(storeId);
}

async function updateProfile(storeId = "store_default", updates = {}) {
  const allowed = {};
  if (updates.store_name) allowed.store_name = String(updates.store_name).trim();
  if (updates.phone) allowed.phone = String(updates.phone).trim();
  if (updates.email) allowed.email = String(updates.email).trim();
  if (updates.owner_name) allowed.owner_name = String(updates.owner_name).trim();
  if (updates.address) allowed.address = String(updates.address).trim();
  if (updates.settings && typeof updates.settings === "object") allowed.settings = updates.settings;

  return storeRepo.updateStore(storeId, allowed);
}

module.exports = {
  getProfile,
  updateProfile
};
