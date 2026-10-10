const express = require("express");
const categoryRepo = require("../repositories/category.repository");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    const categories = await categoryRepo.listCategories();
    return res.json(categories);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
