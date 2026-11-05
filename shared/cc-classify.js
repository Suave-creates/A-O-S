// shared/cc-classify.js — plain script for UI (Cycle Count reconciliation logic)
// Pure functions only - no chrome.* calls, no DOM. Fetching lives in background/index.js
// (CC_FETCH message); this file only turns the two raw row-sets into something renderable.
const CC_CLASSIFY = (() => {

  function rollupStockCheckByContainer(stockCheckRows) {
    const byContainer = new Map();
    for (const row of stockCheckRows) {
      if (!byContainer.has(row.container)) {
        byContainer.set(row.container, {
          container: row.container, rows: [], alrightCount: 0, shortCount: 0, excessCount: 0,
          station: row.station, user: row.user, latestCreateTime: row.createTime,
        });
      }
      const bucket = byContainer.get(row.container);
      bucket.rows.push(row);
      if (row.resultType === "ALRIGHT") bucket.alrightCount++;
      else if (row.resultType === "SHORT") bucket.shortCount++;
      else if (row.resultType === "EXCESS") bucket.excessCount++;
      if (row.createTime > bucket.latestCreateTime) bucket.latestCreateTime = row.createTime;
    }
    for (const bucket of byContainer.values()) {
      if (bucket.shortCount > 0 && bucket.excessCount > 0) bucket.verdict = "MIXED";
      else if (bucket.shortCount > 0) bucket.verdict = "SHORT";
      else if (bucket.excessCount > 0) bucket.verdict = "EXCESS";
      else bucket.verdict = "NO_DISCREPANCY";
    }
    return byContainer;
  }

  function groupDiscrepancyByContainer(discrepancyRows) {
    const map = new Map();
    for (const row of discrepancyRows) {
      if (!map.has(row.container)) map.set(row.container, []);
      map.get(row.container).push(row);
    }
    return map;
  }

  const RESULT_LABELS = {
    CORRECTLY_FLAGGED: { label: "Correctly Flagged", tone: "good" },
    INCORRECTLY_FLAGGED: { label: "Incorrectly Flagged (False Report)", tone: "warn" },
    CORRECTLY_RELEASED: { label: "Correctly Released Clean", tone: "good" },
    DATA_MISMATCH: { label: "Data Mismatch (Released Clean, Stock Check Found Issue)", tone: "bad" },
    UNMATCHED_NO_STOCK_CHECK: { label: "Unmatched (No Stock Check Yet)", tone: "neutral" },
    GHOST: { label: "Ghost Tote (Stock Checked, Never Marked Discrepant)", tone: "bad" },
  };

  // Full outer join on container - every tote from EITHER dataset gets a row.
  function reconcile(discrepancyRows, stockCheckRows) {
    const rollups = rollupStockCheckByContainer(stockCheckRows);
    const discByContainer = groupDiscrepancyByContainer(discrepancyRows);
    const rows = [];

    for (const [container, events] of discByContainer.entries()) {
      const rollup = rollups.get(container);
      for (const event of events) {
        let resultKey;
        if (!rollup) resultKey = "UNMATCHED_NO_STOCK_CHECK";
        else if (event.discrepancyType === "SHORT") resultKey = rollup.verdict === "NO_DISCREPANCY" ? "INCORRECTLY_FLAGGED" : "CORRECTLY_FLAGGED";
        else if (event.discrepancyType === "ALRIGHT") resultKey = rollup.verdict === "NO_DISCREPANCY" ? "CORRECTLY_RELEASED" : "DATA_MISMATCH";
        else resultKey = "UNMATCHED_NO_STOCK_CHECK";
        rows.push({
          ...event,
          stockCheckVerdict: rollup ? rollup.verdict : null,
          stockCheckTime: rollup ? rollup.latestCreateTime : null,
          stockCheckCounts: rollup ? { alright: rollup.alrightCount, short: rollup.shortCount, excess: rollup.excessCount } : null,
          resultKey, resultLabel: RESULT_LABELS[resultKey].label, resultTone: RESULT_LABELS[resultKey].tone,
        });
      }
    }
    for (const [container, rollup] of rollups.entries()) {
      if (discByContainer.has(container)) continue;
      rows.push({
        container, station: rollup.station, user: rollup.user, operationType: null, discrepancyType: null,
        createTime: rollup.latestCreateTime, stockCheckVerdict: rollup.verdict, stockCheckTime: rollup.latestCreateTime,
        stockCheckCounts: { alright: rollup.alrightCount, short: rollup.shortCount, excess: rollup.excessCount },
        resultKey: "GHOST", resultLabel: RESULT_LABELS.GHOST.label, resultTone: RESULT_LABELS.GHOST.tone,
      });
    }
    return rows;
  }

  function summarize(classifiedRows) {
    const summary = { total: classifiedRows.length };
    for (const key of Object.keys(RESULT_LABELS)) summary[key] = 0;
    for (const r of classifiedRows) summary[r.resultKey]++;
    return summary;
  }

  function bump(map, key) {
    const k = key == null || key === "" ? "(blank)" : key;
    map.set(k, (map.get(k) || 0) + 1);
  }

  function discrepancyActivityStats(discrepancyRows) {
    const stats = { total: discrepancyRows.length, short: 0, alright: 0, byStation: new Map(), byUser: new Map(), byOperationType: new Map() };
    for (const r of discrepancyRows) {
      if (r.discrepancyType === "SHORT") stats.short++;
      else if (r.discrepancyType === "ALRIGHT") stats.alright++;
      bump(stats.byStation, r.station); bump(stats.byUser, r.user); bump(stats.byOperationType, r.operationType);
    }
    return stats;
  }

  function repeatedOffenderTotes(discrepancyRows, minCount = 2) {
    const counts = new Map();
    for (const row of discrepancyRows) {
      if (row.discrepancyType !== "SHORT") continue;
      if (!counts.has(row.container)) counts.set(row.container, { container: row.container, count: 0, stations: new Set(), users: new Set(), lastCreateTime: row.createTime });
      const c = counts.get(row.container);
      c.count++;
      if (row.station) c.stations.add(row.station);
      if (row.user) c.users.add(row.user);
      if (row.createTime > c.lastCreateTime) c.lastCreateTime = row.createTime;
    }
    return [...counts.values()]
      .filter((c) => c.count >= minCount)
      .map((c) => ({ ...c, stations: [...c.stations].join(", "), users: [...c.users].join(", ") }))
      .sort((a, b) => b.count - a.count);
  }

  function stockCheckActivityStats(stockCheckRows) {
    const rollups = rollupStockCheckByContainer(stockCheckRows);
    const stats = { totalSkuLines: stockCheckRows.length, totalSessions: rollups.size, noDiscrepancy: 0, short: 0, excess: 0, mixed: 0, byStation: new Map(), byUser: new Map() };
    for (const rollup of rollups.values()) {
      if (rollup.verdict === "NO_DISCREPANCY") stats.noDiscrepancy++;
      else if (rollup.verdict === "SHORT") stats.short++;
      else if (rollup.verdict === "EXCESS") stats.excess++;
      else if (rollup.verdict === "MIXED") stats.mixed++;
      bump(stats.byStation, rollup.station); bump(stats.byUser, rollup.user);
    }
    return stats;
  }

  function ghostTotes(discrepancyRows, stockCheckRows) {
    return reconcile(discrepancyRows, stockCheckRows).filter((r) => r.resultKey === "GHOST");
  }

  // Discrepancy Marked gives epoch-ms numbers; Stock Check gives "YYYY-MM-DD HH:mm:ss.SSS"
  // strings (local/IST). Both treated as local time - browser running this is IST (Bhiwadi).
  function parseCreateTime(value) {
    if (value == null) return null;
    if (typeof value === "number") return new Date(value);
    if (typeof value === "string") return new Date(value.replace(" ", "T"));
    return null;
  }

  function toHourKey(date) { const d = new Date(date); d.setMinutes(0, 0, 0); return d.getTime(); }
  function formatHourLabel(ms) { return new Date(ms).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

  function bucketByHour(rows, getDate, fromDate, toDate) {
    const buckets = new Map();
    let cursor = toHourKey(fromDate);
    const endKey = toHourKey(toDate);
    while (cursor <= endKey) { buckets.set(cursor, { hour: cursor, label: formatHourLabel(cursor), count: 0 }); cursor += 3600000; }
    for (const row of rows) {
      const d = getDate(row);
      if (!d || isNaN(d)) continue;
      const key = toHourKey(d);
      if (!buckets.has(key)) buckets.set(key, { hour: key, label: formatHourLabel(key), count: 0 });
      buckets.get(key).count++;
    }
    return [...buckets.values()].sort((a, b) => a.hour - b.hour);
  }

  // ── Station / operator accuracy breakdowns ──────────────────────────────────
  // "False rate" = of totes this station/operator marked SHORT (and we have a stock check
  // result for), what fraction turned out to have no real discrepancy.
  function groupByField(classifiedRows, field) {
    const map = new Map();
    for (const r of classifiedRows) {
      const key = r[field] == null || r[field] === "" ? "(blank)" : r[field];
      if (!map.has(key)) map.set(key, { key, total: 0, correctlyFlagged: 0, incorrectlyFlagged: 0, correctlyReleased: 0, dataMismatch: 0, ghost: 0, unmatched: 0 });
      const b = map.get(key);
      b.total++;
      if (r.resultKey === "CORRECTLY_FLAGGED") b.correctlyFlagged++;
      else if (r.resultKey === "INCORRECTLY_FLAGGED") b.incorrectlyFlagged++;
      else if (r.resultKey === "CORRECTLY_RELEASED") b.correctlyReleased++;
      else if (r.resultKey === "DATA_MISMATCH") b.dataMismatch++;
      else if (r.resultKey === "GHOST") b.ghost++;
      else if (r.resultKey === "UNMATCHED_NO_STOCK_CHECK") b.unmatched++;
    }
    for (const b of map.values()) {
      const flaggedDenom = b.correctlyFlagged + b.incorrectlyFlagged;
      b.falseRate = flaggedDenom > 0 ? (b.incorrectlyFlagged / flaggedDenom) * 100 : null;
      const issueCount = b.incorrectlyFlagged + b.dataMismatch + b.ghost;
      b.issueRate = b.total > 0 ? (issueCount / b.total) * 100 : 0;
      b.issueCount = issueCount;
    }
    return map;
  }
  function stationBreakdown(classifiedRows) { return groupByField(classifiedRows, "station"); }
  function operatorBreakdown(classifiedRows) { return groupByField(classifiedRows, "user"); }

  // Pareto: entities sorted by issue count desc, with cumulative % of total issues.
  function paretoAnalysis(breakdownMap) {
    const entries = [...breakdownMap.values()].filter(b => b.issueCount > 0).sort((a, b) => b.issueCount - a.issueCount);
    const totalIssues = entries.reduce((s, e) => s + e.issueCount, 0);
    let running = 0;
    return entries.map(e => {
      running += e.issueCount;
      return { ...e, pctOfIssues: totalIssues ? (e.issueCount / totalIssues) * 100 : 0, cumulativePct: totalIssues ? (running / totalIssues) * 100 : 0 };
    });
  }

  // ── Risk scoring (per reconciled row) — formula is intentionally simple and fully
  // shown in the UI, not a black box. Weights are defaults, not validated SLAs, and are
  // configurable from the Settings module (passed in as `weights`, falls back to defaults). ──
  const DEFAULT_RISK_WEIGHTS = {
    base: { GHOST: 40, DATA_MISMATCH: 35, INCORRECTLY_FLAGGED: 25, UNMATCHED_NO_STOCK_CHECK: 15, CORRECTLY_FLAGGED: 5, CORRECTLY_RELEASED: 0 },
    repeatOffenderBonus: 25, gapOver4hBonus: 10, gapOver24hBonus: 20,
  };
  function computeRiskScore(row, repeatOffenderContainers, weights) {
    const w = weights || DEFAULT_RISK_WEIGHTS;
    let score = w.base[row.resultKey] ?? 10;
    const reasons = [`base(${row.resultKey})=${w.base[row.resultKey] ?? 10}`];
    if (repeatOffenderContainers && repeatOffenderContainers.has(row.container)) { score += w.repeatOffenderBonus; reasons.push(`repeat offender tote +${w.repeatOffenderBonus}`); }
    if (row.createTime != null && row.stockCheckTime != null) {
      const reportD = parseCreateTime(row.createTime), checkD = parseCreateTime(row.stockCheckTime);
      if (reportD && checkD) {
        const gapHours = Math.abs(checkD - reportD) / 3600000;
        if (gapHours > 24) { score += w.gapOver24hBonus; reasons.push(`report↔check gap >24h +${w.gapOver24hBonus}`); }
        else if (gapHours > 4) { score += w.gapOver4hBonus; reasons.push(`report↔check gap >4h +${w.gapOver4hBonus}`); }
      }
    }
    score = Math.max(0, Math.min(100, score));
    const category = score >= 75 ? "Critical" : score >= 50 ? "High" : score >= 25 ? "Medium" : "Low";
    return { score, category, reasons };
  }
  function riskFormulaText() {
    return "Risk = base-by-result (Ghost 40 / Data Mismatch 35 / Incorrectly Flagged 25 / Unmatched 15 / Correctly Flagged 5 / Correctly Released 0) + repeat-offender tote (+25) + report↔check time gap (>4h +10, >24h +20), capped 0–100. Low <25, Medium 25–49, High 50–74, Critical ≥75. Editable in Settings.";
  }

  // Actionable subset only (excludes the two "everything's fine" outcomes), sorted by risk desc.
  function alertQueue(classifiedRows, repeatOffenderContainers, weights, limit) {
    const actionable = classifiedRows.filter(r => r.resultKey !== "CORRECTLY_FLAGGED" && r.resultKey !== "CORRECTLY_RELEASED");
    const withRisk = actionable.map(r => ({ row: r, risk: computeRiskScore(r, repeatOffenderContainers, weights) }));
    withRisk.sort((a, b) => b.risk.score - a.risk.score);
    return limit ? withRisk.slice(0, limit) : withRisk;
  }


  // ── Plant health score — transparent weighted composite, not a black box ───────
  function plantHealthScore(summary, ghostSessionRate) {
    const flaggedDenom = summary.CORRECTLY_FLAGGED + summary.INCORRECTLY_FLAGGED;
    const falseRate = flaggedDenom > 0 ? (summary.INCORRECTLY_FLAGGED / flaggedDenom) * 100 : 0;
    const ghostRate = summary.total > 0 ? (summary.GHOST / summary.total) * 100 : 0;
    const pendingRate = summary.total > 0 ? (summary.UNMATCHED_NO_STOCK_CHECK / summary.total) * 100 : 0;
    const score = Math.max(0, Math.min(100, Math.round(100 - (falseRate * 0.4 + ghostRate * 0.3 + pendingRate * 0.3))));
    return { score, falseRate, ghostRate, pendingRate };
  }
  function plantHealthFormulaText() {
    return "Health = 100 − (False-Reporting-Rate% × 0.4 + Ghost-Rate% × 0.3 + Pending-Rate% × 0.3), capped 0–100. Default weights — adjust once real SLA targets are set.";
  }

  // ── Time-to-stock-check distribution (report → physical check), matched rows only ──
  function timeToCheckDistribution(classifiedRows) {
    const buckets = { "<15m": 0, "15-60m": 0, "1-4h": 0, "4-24h": 0, ">24h": 0 };
    for (const r of classifiedRows) {
      if (r.discrepancyType !== "SHORT" || r.stockCheckTime == null) continue;
      const reportD = parseCreateTime(r.createTime), checkD = parseCreateTime(r.stockCheckTime);
      if (!reportD || !checkD) continue;
      const mins = Math.abs(checkD - reportD) / 60000;
      if (mins < 15) buckets["<15m"]++;
      else if (mins < 60) buckets["15-60m"]++;
      else if (mins < 240) buckets["1-4h"]++;
      else if (mins < 1440) buckets["4-24h"]++;
      else buckets[">24h"]++;
    }
    return buckets;
  }

  // ── Insights (templated sentences from real aggregates — no LLM call) ──────────
  function pct(n, d) { return d > 0 ? (n / d) * 100 : null; }
  function fmtPct(v) { return v == null ? "n/a" : v.toFixed(1) + "%"; }

  function generateInsights(current, previous, durationLabel) {
    const insights = [];
    const cur = current.summary;
    const curFalseRate = pct(cur.INCORRECTLY_FLAGGED, cur.CORRECTLY_FLAGGED + cur.INCORRECTLY_FLAGGED);

    // Top false-report station
    const stationPareto = paretoAnalysis(current.stationStats).filter(s => s.incorrectlyFlagged > 0);
    if (stationPareto.length) {
      const top = stationPareto[0];
      const totalFalse = [...current.stationStats.values()].reduce((s, b) => s + b.incorrectlyFlagged, 0);
      const sharePct = pct(top.incorrectlyFlagged, totalFalse);
      insights.push({ tone: "warn", text: `Station ${top.key} generated ${fmtPct(sharePct)} of this period's false discrepancy reports (${top.incorrectlyFlagged} of ${totalFalse}).` });
    }

    // Top operator false-report count
    const opBreakdown = [...current.operatorStats.values()].filter(o => o.correctlyFlagged + o.incorrectlyFlagged >= 3).sort((a, b) => b.incorrectlyFlagged - a.incorrectlyFlagged);
    if (opBreakdown.length && opBreakdown[0].incorrectlyFlagged > 0) {
      const o = opBreakdown[0];
      insights.push({ tone: "warn", text: `Operator ${o.key} reported ${o.correctlyFlagged + o.incorrectlyFlagged} shortages this period, ${o.incorrectlyFlagged} later verified as available (${fmtPct(o.falseRate)} false).` });
    }

    // Repeat offenders callout
    if (current.offenders.length) {
      const top = current.offenders[0];
      insights.push({ tone: "warn", text: `${current.offenders.length} tote(s) were marked SHORT more than once this period — top: ${top.container} (${top.count}×).` });
    }

    // Trend vs previous period (only if we actually have previous-period data)
    if (previous) {
      const prev = previous.summary;
      const prevFalseRate = pct(prev.INCORRECTLY_FLAGGED, prev.CORRECTLY_FLAGGED + prev.INCORRECTLY_FLAGGED);
      if (curFalseRate != null && prevFalseRate != null) {
        const delta = curFalseRate - prevFalseRate;
        const dir = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat vs";
        insights.push({ tone: delta > 0.5 ? "bad" : "good", text: `False reporting rate is ${dir} ${Math.abs(delta).toFixed(1)}pp vs the previous ${durationLabel} (${fmtPct(prevFalseRate)} → ${fmtPct(curFalseRate)}).` });
      }
      const ghostDelta = cur.GHOST - prev.GHOST;
      if (prev.GHOST > 0 || cur.GHOST > 0) {
        const dir = ghostDelta > 0 ? "up" : ghostDelta < 0 ? "down" : "flat vs";
        insights.push({ tone: ghostDelta > 0 ? "bad" : "good", text: `Ghost tote count is ${dir} ${Math.abs(ghostDelta)} vs the previous ${durationLabel} (${prev.GHOST} → ${cur.GHOST}).` });
      }
    } else {
      insights.push({ tone: "neutral", text: `Previous-period comparison unavailable (no data or fetch failed) — trend insights skipped this load.` });
    }

    if (insights.length === 0) insights.push({ tone: "neutral", text: "No notable patterns in this window — volumes too low or everything reconciled cleanly." });
    return insights;
  }

  // ── Recommendations (rule-triggered, tied to real thresholds, no invented causes) ──
  function generateRecommendations(current, thresholds) {
    thresholds = thresholds || { falseRateWarn: 25, minSample: 5, ghostWarn: 5, pendingWarn: 5 };
    const recs = [];
    for (const s of current.stationStats.values()) {
      const denom = s.correctlyFlagged + s.incorrectlyFlagged;
      if (denom >= thresholds.minSample && s.falseRate != null && s.falseRate >= thresholds.falseRateWarn) {
        recs.push({ tone: "warn", text: `Review reporting process at Station ${s.key} — ${fmtPct(s.falseRate)} false-report rate over ${denom} flagged totes.` });
      }
    }
    if (current.summary.GHOST >= thresholds.ghostWarn) {
      recs.push({ tone: "bad", text: `${current.summary.GHOST} totes were stock-checked without ever being marked discrepant — investigate what's triggering stock checks outside the reporting flow.` });
    }
    if (current.summary.UNMATCHED_NO_STOCK_CHECK >= thresholds.pendingWarn) {
      recs.push({ tone: "neutral", text: `${current.summary.UNMATCHED_NO_STOCK_CHECK} totes reported SHORT are still awaiting stock check — follow up to close the loop.` });
    }
    if (current.offenders.length > 0) {
      recs.push({ tone: "warn", text: `${current.offenders.length} repeat-offender tote(s) detected — inspect for a recurring slot/pick issue before next cycle.` });
    }
    if (recs.length === 0) recs.push({ tone: "good", text: "No threshold breaches this period — nothing urgent to action." });
    return recs;
  }

  return {
    rollupStockCheckByContainer, reconcile, summarize, discrepancyActivityStats,
    repeatedOffenderTotes, stockCheckActivityStats, ghostTotes, bucketByHour, parseCreateTime,
    stationBreakdown, operatorBreakdown, paretoAnalysis, computeRiskScore, riskFormulaText,
    plantHealthScore, plantHealthFormulaText, timeToCheckDistribution, generateInsights,
    generateRecommendations, alertQueue, DEFAULT_RISK_WEIGHTS,
    RESULT_LABELS,
  };
})();
