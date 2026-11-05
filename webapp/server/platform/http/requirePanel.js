// Route guard: the signed-in user must be allowed at least one of the named panels (see platform/domain/panels.js).
// Mount it after requireAuth:  app.use("/api/v1/tote-purge", requireAuth, requirePanel("totePurge"), router)

const { canAccess } = require("../domain/panels");

function requirePanel(...keys) {
  return function panelGuard(req, res, next) {
    if (!canAccess(req.user, ...keys)) return res.status(403).json({ error: "You don't have access to this panel" });
    next();
  };
}

module.exports = requirePanel;
