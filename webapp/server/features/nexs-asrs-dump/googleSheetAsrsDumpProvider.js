// Non-production NEXS ASRS Dump provider: Node backend fetches the Google
// Sheet "ASRS Dump" directly via the existing Apps Script client
// (server/integrations/google/appsScriptClient.js - unmodified, same "getAsrsDump" action /
// Script Key it already used for Tote Utilisation).
//
// NOT the production path anymore. Node's own outbound HTTPS request to
// script.google.com fails TLS on this machine (SELF_SIGNED_CERT_IN_CHAIN -
// confirmed live, a network-level TLS-inspection proxy trusted by Chrome
// but not by Node's own CA store), which is exactly why the production
// path now goes through runtimeAsrsDumpProvider.js instead (the SAME
// Chrome-hosted Browser Runtime that already proves this exact class of
// request works, via GET_NEXS_ASRS_DUMP). This file is kept available for
// development/testing where Node's own outbound TLS path DOES work (e.g. a
// network without that inspection proxy, or the local dev mock), selected
// by manually requiring this module instead of runtimeAsrsDumpProvider.js
// in nexsAsrsDumpProvider.js's selector.
//
// Normalization is shared with runtimeAsrsDumpProvider.js via
// asrsDumpNormalizer.js - this file no longer implements its own copy.

const appsScriptClient = require("../../integrations/google/appsScriptClient");
const { normalizeRow, latestOf } = require("./asrsDumpNormalizer");

// fetchAsrsDump({ signal, client }) -> { rows, rowCount, latestIngestedAt, latestUpdatedAt, source }
// `client` is injectable purely for testing (no real network call needed
// to unit-test normalization) - production callers pass nothing and get
// the real appsScriptClient. Never throws for row-level issues (a
// malformed individual row is normalized as best-effort, with unparseable
// fields left null - not dropped, not crashed on). DOES throw for a
// source-level failure (unreachable/misconfigured Apps Script, bad JSON,
// ok:false) - the SAME errors appsScriptClient.fetchAsrsDump() already
// throws, unchanged, so callers can distinguish "no data" from "source
// unavailable".
async function fetchAsrsDump({ signal, client = appsScriptClient } = {}) {
  const rawRows = await client.fetchAsrsDump(signal);
  const rows = rawRows.map(normalizeRow);
  return {
    rows,
    rowCount: rows.length,
    latestIngestedAt: latestOf(rows, "ingestedAt"),
    latestUpdatedAt: latestOf(rows, "lastUpdatedAt"),
    source: "google_sheet_direct",
  };
}

module.exports = { fetchAsrsDump, normalizeRow };
