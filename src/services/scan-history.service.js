/**
 * Scan history service for querying and managing scan history audit trail.
 */

const repo = require("../repositories/scan-history.repository");

async function record(scanData) {
  return repo.recordScan(scanData);
}

async function getHistory(limit = 20, storeId = "store_default") {
  const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return repo.getRecentScans(parsedLimit, storeId);
}

module.exports = {
  record,
  getHistory
};
