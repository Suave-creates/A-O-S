// How a picking station is judged. Pure - no I/O.
//
// Priority comes from the station's configured priority weight (GTP station config):
//   0            -> NONPRIORITY  (a normal station)
//   300000000    -> PRIORITY     (a priority station)
//   anything else-> CHECK        (a supervisor has to confirm what this station is meant to do; no verdict is given)
// Design capacity is 300 items per hour. The station's rate (picks in the window, scaled to an hour) as a share
// of that decides the colour, with a stricter bar for non-priority stations:
//   NONPRIORITY  green > 85%   yellow 70-85%   red < 70%
//   PRIORITY     green > 65%   yellow 50-65%   red < 50%

const DESIGN_CAPACITY_PER_HOUR = 300;
const PRIORITY_WEIGHT = 300000000;
const BANDS = {
  NONPRIORITY: { greenAbove: 85, yellowFrom: 70 },
  PRIORITY: { greenAbove: 65, yellowFrom: 50 },
};
const PRIORITY_CLASSES = ["ALL", "PRIORITY", "NONPRIORITY", "CHECK"];

function priorityClass(weight) {
  if (weight === 0) return "NONPRIORITY";
  if (weight === PRIORITY_WEIGHT) return "PRIORITY";
  return "CHECK";
}

// The share of design capacity a rate reaches, as a whole percent.
const capacityPct = (itemsPerHour) => Math.round((itemsPerHour / DESIGN_CAPACITY_PER_HOUR) * 100);

// "green" | "yellow" | "red" for a priority class and the UNROUNDED percent (a station at 85.4% is not >85 by
// rounding luck); null for a class that gets no verdict.
function healthOf(klass, pct) {
  const b = BANDS[klass];
  if (!b || pct == null) return null;
  return pct > b.greenAbove ? "green" : pct >= b.yellowFrom ? "yellow" : "red";
}

// A station is only judged while it is picking: logged in and configured for the PICKING operation.
const isPicking = (cfg) => !!cfg && cfg.loggedIn && cfg.operationType === "PICKING";

// config: a GTP station row ({id,type,operationType,loggedIn,priorityWeight,userId}) or undefined.
// picks/windowMin: what the station picked in the rolling window.
function assess(cfg, picks, windowMin) {
  if (!cfg) return { known: false, klass: null, picking: false, ratePerHour: null, pct: null, health: null };
  const klass = priorityClass(cfg.priorityWeight);
  const picking = isPicking(cfg);
  const ratePerHour = (picks * 60) / windowMin;
  const exactPct = (ratePerHour / DESIGN_CAPACITY_PER_HOUR) * 100;
  return {
    known: true, klass, picking, ratePerHour: Math.round(ratePerHour), pct: capacityPct(ratePerHour),
    health: picking ? healthOf(klass, exactPct) : null,
  };
}

module.exports = { DESIGN_CAPACITY_PER_HOUR, PRIORITY_WEIGHT, BANDS, PRIORITY_CLASSES, priorityClass, healthOf, isPicking, assess };
