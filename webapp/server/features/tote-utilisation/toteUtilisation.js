// Ported verbatim (no business-rule changes) from
// background/index.js:899-991 (computeToteUtilisation) in the Chrome
// extension. Pure function - no chrome.* APIs were used there, so nothing
// needed to change to run it under Node.
//
// invBaseOf / isValidToteId are small helpers computeToteUtilisation depends
// on in the extension (shared/utils.js + background/index.js); reproduced
// here unchanged so this module has no dependency on the extension's files.

const TOTE_ID_REGEX = /^(TL|TS)[0-9]{10}$/;

function isValidToteId(id) {
  return TOTE_ID_REGEX.test(String(id || "").trim());
}

// Strips a "_PRn" partition suffix so "TL0000003490_PR1" -> "TL0000003490".
function invBaseOf(toteId) {
  const s = String(toteId || "").trim().toUpperCase();
  const m = s.match(/^((?:TL|TS)[0-9]{10})(?:_PR[0-9]+)?$/);
  return m ? m[1] : s;
}

// Default tote capacity (items per tote) by size and product type - operator-set 2026-11-03, the same
// everywhere (Tote Utilisation, the Dashboard, the One Pager). A positive override replaces one value.
const DEFAULT_CAPS = Object.freeze({ largeLens: 300, largeFrame: 200, smallLens: 200, smallFrame: 100 });

function computeToteUtilisation(rows, caps) {
  caps = caps || {};
  const pick = (k) => (Number(caps[k]) > 0 ? Number(caps[k]) : DEFAULT_CAPS[k]);
  const CAP = { largeLens: pick("largeLens"), largeFrame: pick("largeFrame"), smallLens: pick("smallLens"), smallFrame: pick("smallFrame") };

  const STRICT_TOTE = /^(TL|TS)[0-9]{10}(?:_PR[0-9]+)?$/i;

  const toteMap = Object.create(null);
  const mixed = new Set();
  let scanned = 0,
    excludedNonTote = 0;

  for (const r of rows || []) {
    scanned++;
    const rawLoc =
      r.location != null && r.location !== "" ? String(r.location).trim().toUpperCase() : null;
    if (rawLoc != null) {
      if (!STRICT_TOTE.test(rawLoc)) {
        excludedNonTote++;
        continue;
      }
    }

    const toteId = invBaseOf(r.toteId);
    if (!isValidToteId(toteId)) {
      excludedNonTote++;
      continue;
    }

    const qty = Number(r.inventoryCount) || 0;
    const pidNum = parseInt(String(r.pid || "").trim(), 10);
    const productType = !isNaN(pidNum) && pidNum <= 999999 ? "Frame" : "Lens";
    const toteType = toteId.startsWith("TL") ? "Large" : "Small";

    if (!toteMap[toteId]) {
      toteMap[toteId] = { toteId, toteType, products: new Set([productType]), quantity: 0 };
    } else if (!toteMap[toteId].products.has(productType)) {
      toteMap[toteId].products.add(productType);
      mixed.add(toteId);
    }
    toteMap[toteId].quantity += qty;
  }

  const stats = {
    largeLens: { totes: 0, cap: 0, qty: 0, capPer: CAP.largeLens },
    largeFrame: { totes: 0, cap: 0, qty: 0, capPer: CAP.largeFrame },
    smallLens: { totes: 0, cap: 0, qty: 0, capPer: CAP.smallLens },
    smallFrame: { totes: 0, cap: 0, qty: 0, capPer: CAP.smallFrame },
  };
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const detail = [];

  Object.values(toteMap).forEach((t) => {
    if (mixed.has(t.toteId)) return;
    const productType = [...t.products][0] || "Lens";
    let key, capacity;
    if (t.toteType === "Large" && productType === "Lens") {
      key = "largeLens";
      capacity = CAP.largeLens;
    } else if (t.toteType === "Large") {
      key = "largeFrame";
      capacity = CAP.largeFrame;
    } else if (productType === "Lens") {
      key = "smallLens";
      capacity = CAP.smallLens;
    } else {
      key = "smallFrame";
      capacity = CAP.smallFrame;
    }

    const utilisation = capacity > 0 ? t.quantity / capacity : 0;
    stats[key].totes++;
    stats[key].cap += capacity;
    stats[key].qty += t.quantity;
    if (t.quantity >= 1 && t.quantity <= 5) distribution[t.quantity]++;

    detail.push({
      toteId: t.toteId,
      toteType: t.toteType,
      productType,
      quantity: t.quantity,
      capacity,
      utilisation,
    });
  });

  const sum = (a, b) => a + b;
  const cats = ["largeLens", "largeFrame", "smallLens", "smallFrame"];
  const totals = {
    totes: cats.map((k) => stats[k].totes).reduce(sum, 0),
    cap: cats.map((k) => stats[k].cap).reduce(sum, 0),
    qty: cats.map((k) => stats[k].qty).reduce(sum, 0),
  };
  totals.util = totals.cap > 0 ? totals.qty / totals.cap : 0;
  const distTotal = [1, 2, 3, 4, 5].map((k) => distribution[k]).reduce(sum, 0);

  cats.forEach((k) => {
    stats[k].util = stats[k].cap > 0 ? stats[k].qty / stats[k].cap : 0;
  });

  return {
    stats,
    totals,
    distribution,
    distTotal,
    mixed: [...mixed],
    mixedCount: mixed.size,
    detail,
    caps: CAP,
    pipeline: { scanned, excludedNonTote, mixed: mixed.size, counted: totals.totes },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { computeToteUtilisation, isValidToteId, invBaseOf, DEFAULT_CAPS };
