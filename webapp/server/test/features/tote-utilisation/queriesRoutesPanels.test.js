// The /queries router serves several screens, so each panel-specific route carries its own panel guard
// (RULES 10: the server enforces authorization, not just the hidden navigation). The generic
// /:queryId routes stay owner-scoped (the caller must own the query, or be an admin).

const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../../../features/tote-utilisation/queries.routes").router;

function layer(method, path) {
  const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]);
  assert.ok(l, method + " " + path + " is mounted");
  return l.route.stack;
}

// Runs the route's first guard (after the router-level requireAuth) for a user -> "next" | status code.
function firstGuard(stack, user) {
  let outcome = null;
  const res = { status(c) { outcome = c; return this; }, json() { return this; } };
  stack[0].handle({ user }, res, () => { outcome = "next"; });
  return outcome;
}

const ROUTES = [
  ["post", "/tote-utilisation", "utilisation"],
  ["get", "/tote-utilisation/history", "utilisation"],
  ["post", "/pull-quadron-tote", "totePuller"],
  ["post", "/reconcile-quadron-grafana", "lockedToteInfo"],
];

for (const [method, path, panel] of ROUTES) {
  test(`${method.toUpperCase()} /queries${path} needs the "${panel}" panel (direct API calls too)`, () => {
    const stack = layer(method, path);
    assert.equal(firstGuard(stack, { role: "USER", panels: ["dashboard"] }), 403);
    assert.equal(firstGuard(stack, { role: "USER", panels: [panel] }), "next");
    assert.equal(firstGuard(stack, { role: "USER", panels: null }), "next", "panels = NULL means every panel");
    assert.equal(firstGuard(stack, { role: "ADMIN", panels: [] }), "next", "admins see every panel");
  });
}
