const express = require("express");
const { getStore, updateStore } = require("../controllers/store.controller");

const router = express.Router();

router.get("/", getStore);
router.put("/", updateStore);
router.patch("/", updateStore);

module.exports = router;
