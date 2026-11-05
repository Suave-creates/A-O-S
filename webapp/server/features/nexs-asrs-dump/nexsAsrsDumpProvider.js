// NEXS ASRS Dump Provider - the ONE stable interface every consumer
// (NEXS ASRS Dump UI, Tote Purge, future Tote Utilisation) requires. Never
// requires a concrete provider directly, so the active provider can be
// swapped behind this one file without any consumer changing.
//
//   NexsAsrsDumpProvider (this file)
//           |
//           +-- googleSheetAsrsDumpProvider.js   (ACTIVE - the backend calls the
//           |                                     Apps Script endpoint itself;
//           |                                     the signal is honored, so
//           |                                     cancelling a refresh really
//           |                                     aborts the request)
//           +-- bigQueryAsrsDumpProvider.js       (future - not built yet)
//
// NOTE: if Node's outbound HTTPS to script.google.com fails with
// SELF_SIGNED_CERT_IN_CHAIN (a TLS-inspection proxy whose root CA Chrome
// trusts but Node's bundled store does not), point NODE_EXTRA_CA_CERTS at
// that CA's PEM file - see .env.example.

const activeProvider = require("./googleSheetAsrsDumpProvider");

module.exports = {
  fetchAsrsDump: activeProvider.fetchAsrsDump,
};
