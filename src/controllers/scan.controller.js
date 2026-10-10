const { processScan } = require("../services/scan.service");
const scanHistoryService = require("../services/scan-history.service");
const { isValidImagePayload } = require("../middleware/validate.middleware");

async function scan(req, res, next) {
  try {
    const barcode = typeof req.body?.barcode === "string"
      ? req.body.barcode.trim()
      : "";
    const image = typeof req.body?.image === "string"
      ? req.body.image.trim()
      : "";
    const autoSave = Boolean(req.body?.auto_save);

    if (!barcode || !image) {
      return res.status(400).json({
        status: "error",
        message: "barcode and image are required"
      });
    }

    if (!isValidImagePayload(image)) {
      return res.status(400).json({
        status: "error",
        message: "image must be a valid base64 image payload under 10MB"
      });
    }

    const result = await processScan({ barcode, image, autoSave, storeId: req.user.store_id });
    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    return next(error);
  }
}

async function getScanHistory(req, res, next) {
  try {
    const history = await scanHistoryService.getHistory(req.query.limit, req.user.store_id);
    return res.json(history);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  scan,
  getScanHistory
};
