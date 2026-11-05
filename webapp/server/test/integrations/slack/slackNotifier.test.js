// Unit tests for server/integrations/slack/slackNotifier.js. doPost is an injected fake -
// no real HTTPS call to Slack.

const test = require("node:test");
const assert = require("node:assert/strict");
const { postReport, buildBlocks } = require("../../../integrations/slack/slackNotifier");

const REPORT = {
  generatedAt: "2026-09-07T12:00:00.000Z",
  lockedTotes: { summary: { sdCount: 2, p0Count: 1, p1Count: 3, p2Count: 5, total: 11 } },
  utilisation: { totals: { totes: 500, cap: 800, qty: 640, util: 0.8 } },
  totesInAsrs: { large: { frame: 18077, lens: 6619, total: 24696 }, small: { frame: 4, lens: 18683, total: 18687 }, total: { frame: 18081, lens: 25302, total: 43383 } },
  outsideTote: { h12to24: 4, h24plus: 2, total: 6 },
  ccMetrics: { shifts: { ccDone: { A: 231, B: 230, C: 227, Total: 688 }, discrepancies: { A: 119, B: 151, C: 173, Total: 443 }, ccStationsRan: { A: 8, B: 6, C: 6, Total: 20 }, discrepancyStations: { A: 31, B: 40, C: 36, Total: 107 } } },
  compaction: { shifts: { compaction: { A: 0, B: 0, C: 221, Total: 221 }, toteFreed: { A: 0, B: 0, C: 109, Total: 109 } } },
  asrsProduction: { shifts: { jit: { A: 40, B: 33, C: 12, Total: 85 }, njit: { A: 120, B: 95, C: 60, Total: 275 }, total: { A: 160, B: 128, C: 72, Total: 360 } } },
  aisleOccupancy: { occupancy: { average: 80.4 }, large: { average: 85.4 }, short: { average: 74.0 } },
};

test("buildBlocks(): includes every section with the report's real numbers", () => {
  const blocks = buildBlocks(REPORT);
  const text = JSON.stringify(blocks);
  assert.match(text, /Locked Totes/);
  assert.match(text, /Compaction \/ Tote Freed/);
  assert.match(text, /CC Done \/ Discrepancies \/ Station Coverage/);
  assert.match(text, /ASRS Production/);
  assert.match(text, /FR0-Bulk \(items\)/);
  assert.match(text, /Totes In ASRS/);
  assert.match(text, /Tote Utilisation/);
  assert.match(text, /Outside Totes/);
  assert.match(text, /Aisle Occupancy/);
  assert.match(text, /11/); // locked total
  assert.match(text, /80\.0%/); // utilisation formatted as a percentage
  assert.match(text, /Above 24 Hours.*2/); // outsideTote.h24plus
  assert.match(text, /688/); // ccDone total
  assert.match(text, /360/); // asrsProduction grand total
  assert.match(text, /24,696/); // totesInAsrs large total
  assert.match(text, /80\.4%/); // aisle occupancy average - NOT re-multiplied (see fmtAlreadyPct)
});

test("buildBlocks(): missing sections render as em-dashes, never throw", () => {
  const blocks = buildBlocks({});
  assert.doesNotThrow(() => JSON.stringify(blocks));
  assert.match(JSON.stringify(blocks), /—/);
});

test("postReport(): posts blocks to the configured webhook URL and resolves ok on success", async () => {
  let captured;
  const doPost = async (url, body) => {
    captured = { url, body };
    return { status: 200, ok: true, text: "ok" };
  };
  const result = await postReport(REPORT, { webhookUrl: "https://hooks.slack.com/services/T/B/X", doPost });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, "https://hooks.slack.com/services/T/B/X");
  assert.ok(Array.isArray(captured.body.blocks));
});

test("postReport(): throws NOT_CONFIGURED when no webhook URL is set, never silently no-ops", async () => {
  await assert.rejects(
    postReport(REPORT, { webhookUrl: null, doPost: async () => ({ status: 200, ok: true, text: "" }) }),
    (e) => e.code === "NOT_CONFIGURED"
  );
});

test("postReport(): a non-2xx Slack response throws with the response body included", async () => {
  const doPost = async () => ({ status: 400, ok: false, text: "invalid_payload" });
  await assert.rejects(
    postReport(REPORT, { webhookUrl: "https://hooks.slack.com/services/T/B/X", doPost }),
    /HTTP 400.*invalid_payload/
  );
});
