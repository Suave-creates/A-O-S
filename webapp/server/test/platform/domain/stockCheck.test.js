const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyChecks } = require("../../../platform/domain/stockCheck");

const row = (container, resultType, quantity, createTime = "2026-10-13 10:00:00.000") => ({ container, station: "GS1", resultType, quantity, createTime });

test("allAlright: a tote whose every line matched the system is flagged, yet is not Bermuda", () => {
  const c = classifyChecks([row("TL1", "ALRIGHT", 0), row("TL1", "ALRIGHT", 0)]).get("TL1");
  assert.equal(c.allAlright, true);
  assert.equal(c.bermuda, false);
  assert.equal(c.shortQty, 0);
});

test("allAlright: any SHORT or EXCESS line means the tote is not flagged", () => {
  assert.equal(classifyChecks([row("TL1", "ALRIGHT", 0), row("TL1", "SHORT", 3)]).get("TL1").allAlright, false);
  assert.equal(classifyChecks([row("TL1", "ALRIGHT", 0), row("TL1", "EXCESS", 1)]).get("TL1").allAlright, false);
});

test("allAlright is judged on the latest check only", () => {
  const rows = [row("TL1", "SHORT", 4, "2026-10-13 09:00:00.000"), row("TL1", "ALRIGHT", 0, "2026-10-13 10:00:00.000")];
  assert.equal(classifyChecks(rows).get("TL1").allAlright, true);
});

test("Bermuda stays strict: every line SHORT", () => {
  assert.equal(classifyChecks([row("TL1", "SHORT", 2), row("TL1", "SHORT", 5)]).get("TL1").bermuda, true);
  assert.equal(classifyChecks([row("TL1", "SHORT", 2), row("TL1", "ALRIGHT", 0)]).get("TL1").bermuda, false);
});
