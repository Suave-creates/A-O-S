// Live updates over Server-Sent Events. The browser opens ONE stream per tab
// (GET /stream?topics=a,b) and receives only changes; it never triggers an
// upstream fetch or a service login (see server/live/liveHub.js).
//
//   GET  /api/v1/live/stream?topics=connections,dashboard.aisle   (SSE)
//   POST /api/v1/live/refresh  { topic }   manual "refresh now", rate-limited
//   POST /api/v1/live/visibility { sid, visible }   this tab went to / came back from the background
//   GET  /api/v1/live/stats                admin: topics / subscribers / health

const express = require("express");
const defaultRequireAuth = require("../platform/http/requireAuth");
const requireRole = require("../platform/http/requireRole");
const { canSeeTopic } = require("../platform/domain/panels");

const HEARTBEAT_MS = 25 * 1000;
const MAX_STREAMS_PER_USER = 6;
const MAX_STREAMS_TOTAL = 300;

function createLiveRouter({ hub = require("."), requireAuth = defaultRequireAuth, heartbeatMs = HEARTBEAT_MS } = {}) {
  const router = express.Router();
  router.use(requireAuth);

  const perUser = new Map();
  const streams = new Map(); // sid -> { uid, setActive }
  const open = new Set(); // live responses, so shutdown can end them (an open SSE stream would otherwise hold server.close() open)
  let total = 0;

  router.get("/stream", (req, res) => {
    const wanted = String(req.query.topics || "").split(",").map((s) => s.trim()).filter(Boolean);
    const topics = [...new Set(wanted)].filter((t) => canSeeTopic(req.user, t) && hub.accepts(t, { user: req.user }));
    if (topics.length === 0) return res.status(400).json({ error: "No known topics requested", known: hub.topics() });

    const uid = req.user.id;
    if (total >= MAX_STREAMS_TOTAL || (perUser.get(uid) || 0) >= MAX_STREAMS_PER_USER) {
      return res.status(429).json({ error: "Too many live streams open" });
    }
    perUser.set(uid, (perUser.get(uid) || 0) + 1);
    total += 1;

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");

    const send = (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    open.add(res);
    const sid = /^[A-Za-z0-9_-]{8,40}$/.test(String(req.query.sid || "")) ? String(req.query.sid) : null;
    const unsubscribe = hub.subscribe(topics, send, { user: req.user, active: req.query.visible !== "0" });
    if (sid) streams.set(sid, { uid, setActive: unsubscribe.setActive });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      open.delete(res);
      if (sid && streams.get(sid) && streams.get(sid).setActive === unsubscribe.setActive) streams.delete(sid);
      clearInterval(heartbeat);
      unsubscribe();
      total -= 1;
      const n = (perUser.get(uid) || 1) - 1;
      if (n <= 0) perUser.delete(uid); else perUser.set(uid, n);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
  });

  router.post("/refresh", express.json(), (req, res) => {
    const topic = req.body && req.body.topic;
    if (!canSeeTopic(req.user, String(topic || ""))) return res.status(403).json({ error: "You don't have access to this panel" });
    res.json(hub.refresh(String(topic || ""), { user: req.user }));
  });

  router.post("/visibility", express.json(), (req, res) => {
    const s = streams.get(String((req.body && req.body.sid) || ""));
    if (s && s.uid === req.user.id) s.setActive(!!(req.body && req.body.visible));
    res.json({ ok: true });
  });

  router.get("/stats", requireRole("ADMIN"), (req, res) => {
    res.json({ streams: total, topics: hub.stats() });
  });

  router.closeAll = () => { for (const r of [...open]) r.end(); hub.closeAll(); };

  return router;
}

module.exports = createLiveRouter;
module.exports.createLiveRouter = createLiveRouter;
