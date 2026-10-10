const express = require("express");
const { scan, getScanHistory } = require("../controllers/scan.controller");
const { validateScanRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.post("/scan", validateScanRequest, scan);
router.get("/scan/history", getScanHistory);

module.exports = router;
