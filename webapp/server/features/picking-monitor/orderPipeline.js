// The Picking Monitor's order pipeline strip: the counts from the WES dashboard's order panel, for the order flow. Pure - the live feed (server/live/pickingFeeds.js) supplies the counts.
//
// A count that could not be read is `null` with a reason, shown as unavailable - never as 0.

// What the strip shows: the order flow only. Each tile says whether its number follows the chosen window or is
// "right now".
const GROUPS = [
  {
    key: "flow", title: "Flow", note: "orders moving through WES",
    tiles: [
      { key: "synced", label: "Synced into WES", scope: "window", help: "Order lines received in the window" },
      { key: "created", label: "Created", scope: "window", help: "Orders created (not yet allocated) in the window" },
      { key: "inProgress", label: "In progress", scope: "window", help: "Allocated to a cluster that has no station yet" },
      { key: "allocated", label: "Allocated to a station", scope: "now", help: "Orders on a station's cluster right now" },
      { key: "completed", label: "Completed", scope: "window", help: "Orders fully picked in the window" },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap((g) => g.tiles.map((t) => t.key));

// metrics: { key: number|null }, errors: { key: reason }
function buildOrderPipeline({ metrics, errors = {}, filters, windowMin }) {
  if (!metrics || typeof metrics !== "object") throw new Error("buildOrderPipeline needs the pipeline counts");
  const groups = GROUPS.map((g) => ({
    key: g.key, title: g.title, note: g.note,
    tiles: g.tiles.map((t) => {
      const v = metrics[t.key];
      const known = typeof v === "number" && Number.isFinite(v);
      return { key: t.key, label: t.label, scope: t.scope, help: t.help, value: known ? v : null, error: known ? null : errors[t.key] || "not returned" };
    }),
  }));
  return { filters, windowMin, groups, unavailable: groups.flatMap((g) => g.tiles).filter((t) => t.value == null).map((t) => t.key) };
}

module.exports = { buildOrderPipeline, GROUPS, ALL_KEYS };
