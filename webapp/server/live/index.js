// The process-wide live hub (one per backend), with the real feeds registered.
const { createHub } = require("./liveHub");
const { registerFeeds } = require("./feeds");

const hub = createHub({ log: (m) => console.warn(m) });
registerFeeds(hub);

module.exports = hub;
