/**
 * Request validation middleware for scan payload.
 */

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function isValidImagePayload(image) {
  if (typeof image !== "string" || image.trim().length === 0) return false;
  if (image.length > MAX_IMAGE_SIZE_BYTES) return false;

  // Supports data URLs (e.g. data:image/jpeg;base64,...) or plain base64
  return (
    image.startsWith("data:image/") ||
    image.startsWith("data:application/octet-stream;base64,") ||
    (image.length > 50 && /^[A-Za-z0-9+/=]+$/.test(image.slice(0, 100)))
  );
}

function validateScanRequest(req, res, next) {
  const barcode = typeof req.body?.barcode === "string"
    ? req.body.barcode.trim()
    : "";
  const image = typeof req.body?.image === "string"
    ? req.body.image.trim()
    : "";

  if (!barcode) {
    return res.status(400).json({
      status: "error",
      message: "barcode is required and must be a non-empty string"
    });
  }

  if (barcode.length > 64) {
    return res.status(400).json({
      status: "error",
      message: "barcode must be 64 characters or fewer"
    });
  }

  if (!image) {
    return res.status(400).json({
      status: "error",
      message: "image is required and must be a valid base64 string"
    });
  }

  if (!isValidImagePayload(image)) {
    return res.status(400).json({
      status: "error",
      message: "image must be a valid supported base64 image under 10MB"
    });
  }

  req.validatedScan = { barcode, image };
  return next();
}

module.exports = {
  validateScanRequest,
  isValidImagePayload
};
