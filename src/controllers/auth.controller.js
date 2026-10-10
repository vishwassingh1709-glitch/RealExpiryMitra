const authService = require("../services/auth.service");

async function login(req, res, next) {
  try {
    const result = await authService.signIn(req.body || {});
    return res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ status: "error", message: error.message });
    return next(error);
  }
}

async function signup(req, res, next) {
  try {
    const result = await authService.signUp(req.body || {});
    return res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ status: "error", message: error.message });
    return next(error);
  }
}

module.exports = { login, signup };
