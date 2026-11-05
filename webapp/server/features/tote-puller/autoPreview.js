// Auto Preview / Dry-Run - "what would Auto do right now" without ever
// dispatching anything. Reuses, does NOT duplicate, every real Auto
// decision-making function:
//   - capabilitySource.js's fetchCapabilitySource() - the SAME 3 read-only
//     capability fetches autoEngine.js's own runFetchCycle() performs
//   - classification.js's classifyLockedTotes() - the SAME pure function
//     both Classification and real Auto use
//   - autoDiff.js's diffAndMerge() - the SAME differential merge
//   - autoQueue.js's AutoQueue, including peekNext() - the SAME batch
//     selection algorithm next() uses, just non-mutating (see
//     autoQueue.js's own comment on why this is safe)
//   - zonePicker.js's pickNextZone() - the SAME calling-station selector
//
// Everything here operates on its OWN, module-level, preview-only
// AutoQueue instance - completely separate from any real AutoEngine
// session's `session.queue`. server/features/tote-puller/autoEngine.js's `sessions` Map is
// never imported, read, or referenced anywhere in this file.
//
// CRITICAL SAFETY INVARIANTS (see server/test/autoPreview.test.js's
// structural test for the automated proof):
//   - Never imports quadronPull.js, toteDispatchLoop.js, totePullEngine.js,
//     autoEngine.js, or capabilityManager with PULL_QUADRON_TOTE - only the
//     three GET_* read capabilities are ever requested.
//   - Never calls queryManager.createQuery() or auditLog.record() - Preview
//     creates NO queries row, NO audit_logs row, NO outbox entry, per
//     explicit requirement ("must not create an Auto operation/session
//     record").
//   - Never calls classificationTimestamps.touchMany() (the WRITE side) -
//     only the new, read-only getMany() (see classificationTimestamps*.js).
//   - Only ever calls AutoQueue.peekNext(), never AutoQueue.next() - the
//     preview queue is never actually drained.
//
// KNOWN, DELIBERATE LIMITATION: because peekNext() never mutates the
// starvation counter (only a real next() - which this file never calls -
// does), Preview cannot simulate how the starvation guard would evolve
// across multiple REAL dispatched batches. It always reports the batch a
// fresh (or currently-idle) queue would draw right now. This is an
// unavoidable consequence of never consuming queue state, not a bug.

const config = require("../../config");
const capabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const { fetchCapabilitySource } = require("../../integrations/capabilities/capabilitySource");
const { classifyLockedTotes } = require("../../platform/domain/classification");
const { AutoQueue } = require("./autoQueue");
const { diffAndMerge } = require("./autoDiff");
const { pickNextZone, validateZoneConfig } = require("./zonePicker");
const classificationTimestamps = require("../locked-tote-info/classificationTimestamps");

// One shared preview queue, module-level - mirrors classificationEngine.js's
// own single `currentSnapshot` convention (one shared "current reality,"
// not per-user/per-request state). Diffed against on every call via the
// SAME diffAndMerge() a real session's periodic fetch cycle uses, so
// repeated Preview calls show genuine NEW/REMOVED/REPRIORITIZED changes
// over time - exactly like watching a session that fetches on schedule but
// never actually dispatches a tote.
const previewQueue = new AutoQueue();
let previewCounter = 0;

async function runPreview({
  user,
  batchSize,
  zone,
  instanceCode,
  multiZone,
  zones,
  requestCapability = capabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult = capabilityManager.getResult,
  queue = previewQueue, // injectable for tests only - production always uses the shared module queue
}) {
  // Preview must use the SAME calling-station configuration model as real
  // Auto - validateZoneConfig() here is the exact function
  // AutoEngine.start() validates against, not a second/looser copy of that
  // rule. A calling station is REQUIRED, not optional, matching real Auto
  // exactly: Preview fails fast (before any live capability fetch) on a
  // missing/invalid zone config, rather than silently previewing without one.
  const zoneConfigInput = { multiZone: !!multiZone, zone, instanceCode, zones };
  const zoneValidation = validateZoneConfig(zoneConfigInput);
  if (!zoneValidation.ok) return { ok: false, code: 400, reason: zoneValidation.reason };

  // Mirrors AutoEngine.start()'s own resolvedZoneConfig construction
  // exactly (server/features/tote-puller/autoEngine.js) - the SAME shape pickNextZone()
  // expects, built the SAME way, not a second implementation.
  const resolvedZoneConfig = zoneConfigInput.multiZone
    ? {
        multiZone: true,
        zones: zones.map((z) => ({ id: z.id, zone: String(z.zone), instanceCode: String(z.instanceCode), percentage: Number(z.percentage) || 0 })),
      }
    : { multiZone: false, zone: zone.trim(), instanceCode: instanceCode.trim(), zones: [] };

  const fetchOpts = { user, requestCapability, wait, getResult };
  const [locked, supervisor, inventory] = await Promise.all([
    fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_GRAFANA_LOCKED_TOTES" }),
    fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_GRAFANA_SUPERVISOR_DUMP" }),
    fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_QUADRON_INVENTORY" }),
  ]);

  if (!locked.ok) {
    return { ok: false, code: 502, reason: `Locked Tote Dump unavailable: ${locked.reason}` };
  }

  const { totes, summary } = classifyLockedTotes({
    lockedRows: locked.rows,
    supervisorRows: supervisor.ok ? supervisor.rows : [],
    inventoryRows: inventory.ok ? inventory.rows : [],
  });

  const { removed, inserted, reprioritized } = diffAndMerge(queue, totes);

  // toteId -> {location, totalToteInv, reason} - classifyLockedTotes()
  // already computed these; AutoQueue entries themselves don't carry them
  // (only priority/source/worstPid/scarcityCount), so this is a report-time
  // join against the just-fetched classification output, not a second
  // computation of anything.
  const detailByTote = new Map(totes.map((t) => [t.toteId, t]));

  const snap = queue.snapshot();
  const orderedEntries = [...snap.sd, ...snap.p0, ...snap.p1, ...snap.p2];
  const lockedSinceMap = await classificationTimestamps.getMany(orderedEntries.map((e) => e.toteId)).catch(() => new Map());

  function toRow(entry) {
    const detail = detailByTote.get(entry.toteId) || {};
    return {
      toteId: entry.toteId,
      priority: entry.priority,
      location: detail.location ?? null,
      totalToteInv: detail.totalToteInv ?? null,
      lockedSince: lockedSinceMap.get(entry.toteId) ?? null,
      reason: detail.reason ?? null,
      source: entry.source,
    };
  }

  const queueRows = orderedEntries.map(toRow);

  const resolvedBatchSize = batchSize != null ? batchSize : config.autoBatchSize;
  const firstBatch = queue.peekNext(resolvedBatchSize).map(toRow);

  // Calling station is ALWAYS operator-provided (see the Manual/Auto
  // calling-station investigation) - never guessed or defaulted from live
  // data. Computed via the SAME pickNextZone() real Auto uses, against the
  // SAME resolvedZoneConfig validated above, with a fresh {} credits object
  // (mirrors a session's own zoneCredits being reset at start) - this
  // reports exactly what the FIRST call of a brand-new session with this
  // configuration would pick.
  const picked = pickNextZone(resolvedZoneConfig, {});
  const callingStation = { zone: picked.zone, instanceCode: picked.instanceCode };

  previewCounter++;
  return {
    ok: true,
    preview: {
      previewId: previewCounter,
      generatedAt: new Date().toISOString(),
      totalLockedTotes: summary.total,
      sdCount: summary.sdCount,
      p0Count: summary.p0Count,
      p1Count: summary.p1Count,
      p2Count: summary.p2Count,
      totalQueueCount: snap.total,
      queue: queueRows,
      batchSize: resolvedBatchSize,
      firstBatch,
      callingStation,
      diff: { removed, inserted, reprioritized },
      degraded: { supervisor: !supervisor.ok, inventory: !inventory.ok },
      degradedReasons: { supervisor: supervisor.ok ? null : supervisor.reason, inventory: inventory.ok ? null : inventory.reason },
    },
  };
}

module.exports = { runPreview };
