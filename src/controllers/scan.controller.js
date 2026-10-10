const { processScan } = require("../services/scan.service");
const scanHistoryService = require("../services/scan-history.service");
const { isValidImagePayload } = require("../middleware/validate.middleware");
const dateExtraction = require("../services/date-extraction.service");

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

async function extractLabelDates(req, res, next) {
  try {
    const image = typeof req.body?.image === "string" ? req.body.image.trim() : "";
    const variants = Array.isArray(req.body?.image_variants) ? req.body.image_variants.slice(0, 1) : [];
    if (!image || !isValidImagePayload(image)) {
      return res.status(400).json({ status: "error", message: "A valid date-label photo is required." });
    }
    if (variants.some((variant) => !isValidImagePayload(variant))) {
      return res.status(400).json({ status: "error", message: "Image preprocessing variant is invalid." });
    }
    if (image.length + variants.reduce((total, variant) => total + variant.length, 0) > 12 * 1024 * 1024) {
      return res.status(413).json({ status: "error", message: "Label photos must total 12 MB or less." });
    }
    const result = await dateExtraction.extractDates({ barcode: String(req.body?.barcode || "").slice(0, 128), image, imageVariants: variants });
    return res.status(result.status === "invalid_image" ? 400 : 200).json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  scan,
  getScanHistory,
  extractLabelDates
};
