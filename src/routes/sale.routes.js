const express = require("express");
const { recordSale, listSales, getSalesSummary } = require("../controllers/sale.controller");

const router = express.Router();

router.post("/", recordSale);
router.get("/", listSales);
router.get("/summary", getSalesSummary);

module.exports = router;
