const express = require("express");
const {
  listInventory,
  getInventory,
  createManual,
  confirmSave,
  updateInventory,
  deleteInventory,
  getSummary
} = require("../controllers/inventory.controller");

const router = express.Router();

router.get("/summary", getSummary);
router.get("/", listInventory);
router.get("/:id", getInventory);
router.post("/", confirmSave);
router.post("/confirm", confirmSave);
router.post("/manual", createManual);
router.patch("/:id", updateInventory);
router.put("/:id", updateInventory);
router.delete("/:id", deleteInventory);

module.exports = router;
