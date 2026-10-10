const saleService = require("../services/sale.service");

async function recordSale(req, res, next) {
  try {
    const result = await saleService.recordSale(req.body || {}, req.user.store_id);
    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    return next(error);
  }
}

async function listSales(req, res, next) {
  try {
    const options = {
      store_id: req.user.store_id,
      range: req.query.range || req.query.filter || "all",
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0
    };
    const sales = await saleService.listSales(options);
    return res.json(sales);
  } catch (error) {
    return next(error);
  }
}

async function getSalesSummary(req, res, next) {
  try {
    const options = {
      store_id: req.user.store_id,
      range: req.query.range || req.query.filter || "today"
    };
    const summary = await saleService.getSummary(options);
    return res.json(summary);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  recordSale,
  listSales,
  getSalesSummary
};
