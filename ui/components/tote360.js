// ui/components/tote360.js
// Global "Tote 360" search — available from every tab. Fires location/tracker, scanner events,
// CC reconciliation, order/wave context, live Quadron inventory, and blocked-inventory checks in
// parallel via the TOTE360_FETCH background message, then synthesizes one answer instead of
// showing five separate raw payloads. Every sentence in the summary is generated from a real
// field returned that call — nothing here is templated from data we don't have.

const Tote360 = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function statusTone(status) {
    if (status === "On Location") return "good";
    if (status === "Buffer") return "neutral";
    if (status === "Outside Tote") return "warn";
    if (status === "Bad Tracker") return "bad";
    return "neutral";
  }

  function fmtDate(v) {
    if (v == null) return "—";
    const d = typeof v === "number" ? new Date(v) : new Date(String(v).replace(" ", "T"));
    return isNaN(d) ? String(v) : d.toLocaleString();
  }

  // ── synthesis: real sentences from real fields, nothing invented ───────────
  function buildSummary(data) {
    const lines = [];

    // location
    if (data.location) {
      const loc = data.location;
      lines.push({
        tone: statusTone(data.status),
        text: `Status: ${data.status} — last seen at "${esc(loc.location)}"${loc.lane ? ` (lane ${esc(loc.lane)})` : ""}, updated ${fmtDate(loc.updated_timestamp)}.`,
      });
      if (data.lastGoodLocation) {
        lines.push({ tone: "neutral", text: `Tracker is currently bad — last known good location before that was "${esc(data.lastGoodLocation)}".` });
      }
    } else {
      lines.push({ tone: "neutral", text: `No tracker/location record found for this tote in Quadron.` });
    }

    // live inventory
    if (data.liveInventory) {
      if (data.liveInventory.length === 0) {
        lines.push({ tone: "neutral", text: `Not currently showing any live inventory in Quadron (may be empty, outside the ASRS, or between scans).` });
      } else {
        const totalQty = data.liveInventory.reduce((s, x) => s + x.quantity, 0);
        lines.push({ tone: "good", text: `Holds ${data.liveInventory.length} SKU(s), ${totalQty} unit(s) total, per live Quadron inventory.` });
      }
    } else if (data.liveInventoryError) {
      lines.push({ tone: "neutral", text: `Live inventory lookup failed: ${esc(data.liveInventoryError)}` });
    }

    // blocked inventory
    const blocked = (data.blockedInfo || []).filter(b => b.blocked > 0);
    if (blocked.length) {
      lines.push({ tone: "warn", text: `${blocked.length} SKU(s) on board have blocked inventory: ${blocked.map(b => `${esc(b.sku)} (${b.blocked} blocked of ${b.total})`).join(", ")}.` });
    }

    // CC reconciliation — most recent discrepancy event
    if (data.discrepancyEvents && data.discrepancyEvents.length) {
      const latest = data.discrepancyEvents[0];
      lines.push({
        tone: latest.discrepancy_type === "SHORT" ? "warn" : "good",
        text: `Cycle Count: most recently marked ${esc(latest.discrepancy_type)} at ${esc(latest.station)} by ${esc(latest.user)}, ${fmtDate(latest.create_time)}.`,
      });
      if (data.stockCheckRows && data.stockCheckRows.length) {
        const scLatest = data.stockCheckRows[0];
        lines.push({ tone: scLatest.type === "SHORT" || scLatest.type === "EXCESS" ? "warn" : "good", text: `Most recent stock check result: ${esc(scLatest.type)} (SKU ${esc(scLatest.sku)}, qty ${scLatest.quantity}), ${fmtDate(scLatest.create_time)}.` });
      } else if (latest.discrepancy_type === "SHORT") {
        lines.push({ tone: "neutral", text: `No stock check found yet for that report — may still be pending.` });
      }
    }

    // order / wave context
    if (data.orderLines && data.orderLines.length) {
      const o = data.orderLines[0];
      lines.push({ tone: "neutral", text: `Active on Order #${esc(o.order_id)} (Wave ${esc(o.wave)}), SKU ${esc(o.sku)}, ${o.quantity_left} unit(s) pending, waiting ${o.minutes_elapsed} min at ${esc(o.Slot)}.` });
    }

    if (lines.length === 0) lines.push({ tone: "neutral", text: "No records found for this tote across any connected system." });
    return lines;
  }

  function tableOrEmpty(rows, cols, emptyMsg) {
    if (!rows || rows.length === 0) return `<div class="t360-empty">${esc(emptyMsg)}</div>`;
    return `<div class="t360-table-wrap"><table>
      <thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(c.fmt ? c.fmt(r[c.key]) : r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
  }

  function render(data) {
    const summary = buildSummary(data);
    $("tote360Body").innerHTML = `
      <div class="t360-title">${esc(data.container)} <span class="t360-badge t360-tone-${statusTone(data.status)}">${esc(data.status)}</span></div>
      <div class="t360-sub">Tote 360 — location · inventory · cycle count · order context, correlated live</div>

      <div class="t360-summary">${summary.map(s => `<div class="t360-insight t360-tone-${s.tone}">${s.text}</div>`).join("")}</div>

      <div class="t360-section">
        <div class="t360-section-h">Live Inventory Contents (Quadron)</div>
        ${tableOrEmpty(data.liveInventory, [{ key: "sku", label: "SKU" }, { key: "quantity", label: "Qty" }], data.liveInventoryError || "Empty or not found in live inventory.")}
      </div>

      <div class="t360-section">
        <div class="t360-section-h">Cycle Count — Recent Discrepancy Events</div>
        ${tableOrEmpty(data.discrepancyEvents, [
          { key: "create_time", label: "Time", fmt: fmtDate }, { key: "station", label: "Station" }, { key: "user", label: "User" },
          { key: "operation_type", label: "Operation" }, { key: "discrepancy_type", label: "Marked As" },
        ], "No Discrepancy Marked events found for this tote.")}
      </div>

      <div class="t360-section">
        <div class="t360-section-h">Cycle Count — Recent Stock Check Rows</div>
        ${tableOrEmpty(data.stockCheckRows, [
          { key: "create_time", label: "Time", fmt: fmtDate }, { key: "sku", label: "SKU" }, { key: "quantity", label: "Qty" },
          { key: "type", label: "Result" }, { key: "station", label: "Station" }, { key: "user", label: "User" },
        ], "No Stock Check rows found for this tote.")}
      </div>

      <div class="t360-section">
        <div class="t360-section-h">Order / Wave Context</div>
        ${tableOrEmpty(data.orderLines, [
          { key: "order_id", label: "Order" }, { key: "wave", label: "Wave" }, { key: "sku", label: "SKU" },
          { key: "priority", label: "Priority" }, { key: "quantity_left", label: "Qty Left" }, { key: "minutes_elapsed", label: "Waiting (min)" }, { key: "Slot", label: "Slot" },
        ], "No active order line referencing this tote right now.")}
      </div>

      <div class="t360-section">
        <div class="t360-section-h">Recent Scanner Events <span style="font-weight:400;color:var(--muted-dim)">— raw decision/reason, not categorized</span></div>
        ${tableOrEmpty(data.scans, [
          { key: "create_time", label: "Time", fmt: fmtDate }, { key: "scanner", label: "Scanner" }, { key: "decision", label: "Decision" }, { key: "decision_reason", label: "Reason" },
        ], "No recent scanner events found for this tote.")}
      </div>
    `;
  }

  async function search(container) {
    container = (container || "").trim();
    if (!container) return;
    openPanel();
    $("tote360Body").innerHTML = `<div class="t360-loading">Correlating location, inventory, cycle count, and order data for ${esc(container)}…</div>`;
    $("tote360Btn").disabled = true;
    try {
      const resp = await QTP_UTILS.sendMessageWithTimeout({ type: "TOTE360_FETCH", container }, 30000);
      if (!resp || !resp.ok) throw new Error((resp && resp.reason) || "Tote 360 lookup failed");
      render(resp);
    } catch (e) {
      $("tote360Body").innerHTML = `<div class="t360-error">${esc(e.message || String(e))}</div>`;
    } finally {
      $("tote360Btn").disabled = false;
    }
  }

  function openPanel() { $("tote360Panel").classList.add("open"); $("tote360Overlay").classList.remove("hidden"); }
  function closePanel() { $("tote360Panel").classList.remove("open"); $("tote360Overlay").classList.add("hidden"); }

  function init() {
    const input = $("tote360Input"), btn = $("tote360Btn");
    if (!input || !btn) return;
    btn.addEventListener("click", () => search(input.value));
    input.addEventListener("keydown", e => { if (e.key === "Enter") search(input.value); });
    $("tote360CloseBtn").addEventListener("click", closePanel);
    $("tote360Overlay").addEventListener("click", closePanel);
  }

  return { init, search };
})();
