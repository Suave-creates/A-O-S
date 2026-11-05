// One Pager Report -> Slack (2026-09-07, operator-approved: Slack instead
// of email, via an Incoming Webhook - simplest option, no bot/app setup).
// POSTs Slack's "blocks" JSON to one fixed webhook URL
// (SLACK_ONE_PAGER_REPORT_WEBHOOK_URL, see .env.example) - that URL is
// itself the credential (anyone holding it can post to that one channel),
// so it lives only in server-side config, exactly like every other secret
// in this app (never sent to the browser, never logged in full).

const config = require("../../config");

function fmtPct(fraction) {
  return fraction == null ? "—" : `${(Number(fraction) * 100).toFixed(1)}%`;
}
// aisleOccupancy's own average/values are ALREADY 0-100 (see
// dashboardEngine.js's combineAisleOccupancy() and public/js/dashboard.js's
// identical row.average.toFixed(2)+"%" rendering) - NOT a 0-1 fraction like
// utilisation.totals.util, so this is deliberately a separate formatter
// from fmtPct() above rather than the same one applied inconsistently.
function fmtAlreadyPct(value) {
  return value == null ? "—" : `${Number(value).toFixed(1)}%`;
}
function nf(n) {
  return n == null ? "—" : Number(n).toLocaleString();
}

// Pure - exported for direct unit testing without any network call.
function shiftLine(label, row) {
  const r = row || {};
  return `${label}: A ${nf(r.A)} · B ${nf(r.B)} · C ${nf(r.C)} · *Total ${nf(r.Total)}*`;
}

function buildBlocks(report) {
  const lt = (report && report.lockedTotes && report.lockedTotes.summary) || {};
  const ut = (report && report.utilisation && report.utilisation.totals) || {};
  const tia = (report && report.totesInAsrs) || {};
  const ot = (report && report.outsideTote) || {};
  const cc = (report && report.ccMetrics && report.ccMetrics.shifts) || {};
  const cp = (report && report.compaction && report.compaction.shifts) || {};
  const ap = (report && report.asrsProduction && report.asrsProduction.shifts) || {};
  const ao = report && report.aisleOccupancy;

  return [
    { type: "header", text: { type: "plain_text", text: "📋 ASRS One Pager Report" } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Generated ${report && report.generatedAt}` }] },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*🔒 Locked Totes*\n` +
          `Supervisor Lock: ${nf(lt.sdCount)}   •   P0: ${nf(lt.p0Count)}   •   P1: ${nf(lt.p1Count)}   •   P2: ${nf(lt.p2Count)}   •   *Total: ${nf(lt.total)}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*🗜️ Compaction / Tote Freed*\n${shiftLine("Compaction", cp.compaction)}\n${shiftLine("Tote Freed", cp.toteFreed)}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*🗓️ CC Done / Discrepancies / Station Coverage*\n${shiftLine("CC Done", cc.ccDone)}\n${shiftLine("Discrepancies", cc.discrepancies)}\n` +
          `${shiftLine("Stations Ran", cc.ccStationsRan)}\n${shiftLine("Stations Flagged (SHORT)", cc.discrepancyStations)}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📦 ASRS Production*\n${shiftLine("JIT", ap.jit)}\n${shiftLine("NJIT", ap.njit)}\n${shiftLine("FR0", ap.fr0)}\n${shiftLine("FR0-Bulk (items)", ap.bulk)}\n${shiftLine("Total", ap.total)}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*📦 Totes In ASRS*\nLarge: Frame ${nf(tia.large && tia.large.frame)} · Lens ${nf(tia.large && tia.large.lens)} · *${nf(tia.large && tia.large.total)}*\n` +
          `Small: Frame ${nf(tia.small && tia.small.frame)} · Lens ${nf(tia.small && tia.small.lens)} · *${nf(tia.small && tia.small.total)}*\n` +
          `*Total: ${nf(tia.total && tia.total.total)}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📊 Tote Utilisation*\nTotes: ${nf(ut.totes)}   •   Capacity: ${nf(ut.cap)}   •   Qty: ${nf(ut.qty)}   •   *Utilisation: ${fmtPct(ut.util)}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🚚 Outside Totes*\n12-24 Hours: ${nf(ot.h12to24)}   •   Above 24 Hours: ${nf(ot.h24plus)}   •   *Total: ${nf(ot.total)}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📶 Aisle Occupancy*\nOverall Average: ${fmtAlreadyPct(ao && ao.occupancy && ao.occupancy.average)}   •   Large Avg: ${fmtAlreadyPct(ao && ao.large && ao.large.average)}   •   Short Avg: ${fmtAlreadyPct(ao && ao.short && ao.short.average)}`,
      },
    },
  ];
}

async function defaultDoPost(webhookUrl, body) {
  const resp = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await resp.text().catch(() => "");
  return { status: resp.status, ok: resp.ok, text };
}

async function postReport(report, { webhookUrl = config.slackOnePagerReportWebhookUrl, doPost = defaultDoPost } = {}) {
  if (!webhookUrl) {
    const err = new Error("SLACK_ONE_PAGER_REPORT_WEBHOOK_URL is not configured - ask an admin to set it before sending to Slack");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const { status, ok, text } = await doPost(webhookUrl, { blocks: buildBlocks(report) });
  if (!ok) {
    throw new Error(`Slack webhook responded HTTP ${status}${text ? `: ${text}` : ""}`);
  }
  return { ok: true };
}

module.exports = { postReport, buildBlocks };
