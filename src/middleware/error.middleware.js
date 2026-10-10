/**
 * Centralized error handling middleware.
 */

function notFound(req, res) {
  res.status(404).json({
    status: "not_found",
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
}

function errorHandler(error, _req, res, _next) {
  // Safe logging without credentials or base64 image payloads
  const sanitizedMessage = typeof error?.message === "string"
    ? error.message.replace(/apikey=[^&\s]+/gi, "apikey=REDACTED")
    : "Unknown error";

  console.error("Internal Error:", sanitizedMessage);

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      status: "error",
      message: "Invalid JSON request body"
    });
  }

  const statusCode = Number(error?.statusCode || error?.status || 500);

  return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
    status: "error",
    message: statusCode < 500 ? sanitizedMessage : "Internal server error"
  });
}

module.exports = { notFound, errorHandler };
