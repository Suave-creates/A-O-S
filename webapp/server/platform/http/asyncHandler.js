// Express 4 does not automatically catch rejected promises from an async
// route handler - wrap every async handler with this so a thrown/rejected
// error reaches the error-handling middleware in server/index.js instead of
// crashing the process or hanging the request.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
