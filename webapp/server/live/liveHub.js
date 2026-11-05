// Live hub: the ONE place that decides when upstream data is fetched for
// live screens, and fans the result out to every connected browser.
//
// Why it exists (operator requirement: live updates without overloading the
// server or the NexS/Grafana/Concinity logins):
//   - A browser NEVER triggers an upstream call. It only subscribes to a
//     topic; the hub owns the fetch.
//   - One fetch per topic no matter how many browsers watch it (single-flight,
//     never overlapping), through the existing shared logins.
//   - Demand-driven: a topic is only polled while at least one browser is
//     subscribed (plus a short grace period so a tab switch doesn't stop and
//     restart it). Nobody watching = zero upstream traffic.
//   - Change-driven: subscribers get a "data" event only when the snapshot
//     actually changed (stable-JSON hash), carrying which top-level keys
//     changed so the UI can animate exactly what moved. Unchanged polls send
//     only a tiny "checked" event.
//   - Failure-aware: consecutive failures back off exponentially (capped), and
//     subscribers are told the data is stale instead of being shown a guess.
//
// Background guardrail (registerFeed `backgroundIntervalMs`, opt-in): a feed that reads an upstream polls at its
// normal interval only while at least one subscriber is ACTIVE (its tab visible); when every subscriber is in a
// background tab it polls at the slow interval instead, and the same shared snapshot is served to all. A tab that
// becomes visible again triggers a fetch at once if the snapshot is older than the normal interval. A manual
// Refresh is unaffected.
//
// Topic scopes (registerFeed `scope`):
//   shared (default)  one instance for everyone          "connections"
//   user              one instance per signed-in user    "tote-utilisation.history"
//                     (data that depends on who is asking)
//   key               one instance per user + key        "query:Q-123", "tote-session:abc"
//                     (progress of one job; `key` is validated, and the feed's
//                     fetch() must itself enforce ownership)
// `roles` limits who may subscribe. `stopWhen(data)` ends polling once a
// snapshot is terminal (a finished job) - no more load, no client cleanup.
// Instances for user/key scopes are created on demand and dropped when idle.
//
// Pure of HTTP: the SSE transport lives in routes/live.routes.js. Time and
// timers are injected so this is fully unit-testable.

const MAX_BACKOFF_MS = 5 * 60 * 1000;

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Top-level keys whose value changed between two snapshots; null when the
// shapes aren't comparable objects (the UI then treats everything as changed).
function changedKeys(prev, next) {
  if (!isPlainObject(prev) || !isPlainObject(next)) return null;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => stableStringify(prev[k]) !== stableStringify(next[k]));
}

function createHub({
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  idleGraceMs = 30 * 1000,
  log = () => {},
} = {}) {
  const defs = new Map(); // topic name -> definition
  const feeds = new Map(); // instance id -> live state

  const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

  function registerFeed({ topic, intervalMs, minRefreshMs = 5000, fetch, scope = "shared", roles = null, stopWhen = null, backgroundIntervalMs = 0 }) {
    if (!topic || typeof fetch !== "function" || !(intervalMs > 0)) throw new Error("registerFeed: topic, fetch() and intervalMs are required");
    if (!["shared", "user", "key"].includes(scope)) throw new Error(`registerFeed: bad scope for ${topic}`);
    if (topic.includes(":") || topic.includes("#")) throw new Error(`registerFeed: topic names may not contain ':' or '#': ${topic}`);
    if (defs.has(topic)) throw new Error(`registerFeed: topic already registered: ${topic}`);
    defs.set(topic, { topic, intervalMs, minRefreshMs, fetch, scope, roles, stopWhen, backgroundIntervalMs: backgroundIntervalMs > intervalMs ? backgroundIntervalMs : 0 });
  }

  const hasTopic = (t) => defs.has(String(t).split(":")[0]);
  const topics = () => [...defs.keys()];

  // spec ("name" or "name:key") + who is asking -> { def, key, id } or null when
  // unknown, malformed, or not allowed for that user.
  function resolve(spec, ctx = {}) {
    const text = String(spec);
    const i = text.indexOf(":");
    const name = i < 0 ? text : text.slice(0, i);
    const key = i < 0 ? null : text.slice(i + 1);
    const def = defs.get(name);
    if (!def) return null;
    const user = ctx.user || null;
    if (def.roles && (!user || !def.roles.includes(user.role))) return null;
    if (def.scope === "key") {
      if (!key || !KEY_RE.test(key) || !user) return null;
    } else if (key !== null) return null;
    if (def.scope !== "shared" && !user) return null;
    const id = def.scope === "shared" ? name : def.scope === "user" ? `${name}#${user.id}` : `${name}:${key}#${user.id}`;
    return { def, key, id, spec: text, user };
  }

  const accepts = (spec, ctx) => resolve(spec, ctx) !== null;

  function instance(r) {
    let feed = feeds.get(r.id);
    if (!feed) {
      feed = {
        id: r.id, topic: r.spec, def: r.def, intervalMs: r.def.intervalMs, minRefreshMs: r.def.minRefreshMs,
        ctx: { user: r.user, key: r.key },
        subscribers: new Set(),
        timer: null, idleTimer: null, running: false,
        version: 0, snapshot: null, hash: null, at: null, checkedAt: null,
        failures: 0, error: null, lastRunAt: 0, finished: false,
      };
      feeds.set(r.id, feed);
    }
    return feed;
  }

  function broadcast(feed, event) {
    for (const sub of [...feed.subscribers]) {
      try {
        sub.send(event);
      } catch (e) {
        feed.subscribers.delete(sub); // dead connection - never let it break the others
      }
    }
  }

  function dataEvent(feed, extra) {
    return { type: "data", topic: feed.topic, version: feed.version, at: feed.at, checkedAt: feed.checkedAt, data: feed.snapshot, stale: !!feed.error, ...extra };
  }

  function safeStop(fn, data) {
    try { return fn(data); } catch (e) { return false; }
  }

  // On-demand topics (operator decision 2026-11-04: no automatic refresh timers - each screen refreshes on the
  // auto-refresh interval its user picks): the first subscriber gets a first read, after that the feed reads again
  // only when asked (refresh()). A first read that fails is retried with backoff so a screen never stays empty.
  function markOnDemand(list) {
    for (const t of list) { const d = defs.get(t); if (!d) throw new Error(`markOnDemand: unknown topic ${t}`); d.onDemand = true; }
  }

  // ── Central auto refresh of an on-demand topic (the Dashboard tiles, set by an admin - operator decision
  // 2026-11-04). ONE timer per topic for the whole site: it reads every autoMs after the last read (a manual
  // Refresh restarts the countdown), only while at least one subscriber has the screen in view - so the load
  // depends on the interval, never on how many people watch. 0 = off (reads only when asked).
  const anyActive = (feed) => { for (const s of feed.subscribers) if (s.active) return true; return false; };

  function autoArm(feed) {
    feed.autoNextAt = null;
    const every = feed.def.autoMs || 0;
    if (!every || feed.subscribers.size === 0 || feed.running) return;
    if (!anyActive(feed)) { if (feed.timer) { cancel(feed.timer); feed.timer = null; } return; } // resumes when someone looks
    const delay = Math.max(0, (feed.lastRunAt || 0) + every - now());
    if (feed.timer) cancel(feed.timer);
    feed.autoNextAt = now() + delay;
    feed.timer = schedule(() => {
      feed.timer = null;
      feed.autoNextAt = null;
      if (feed.subscribers.size === 0) return;
      if (!anyActive(feed)) return; // nobody looking: the next look re-arms it
      feed.manualRun = true; // an auto refresh behaves like pressing Refresh
      run(feed);
    }, delay);
  }

  function setAutoInterval(topic, ms) {
    const d = defs.get(topic);
    if (!d) throw new Error(`setAutoInterval: unknown topic ${topic}`);
    if (!d.onDemand) throw new Error(`setAutoInterval: ${topic} is not an on-demand topic`);
    d.autoMs = Math.max(0, Number(ms) || 0);
    const feed = feeds.get(topic);
    if (!feed || feed.running) return;
    if (feed.snapshot === null && feed.timer) return; // its first read is on the way
    if (feed.timer) { cancel(feed.timer); feed.timer = null; }
    autoArm(feed);
  }

  // { everyMs, nextAt } of a topic's central auto refresh (nextAt null: off, nobody watching, or reading now)
  function autoInfo(topic) {
    const d = defs.get(topic);
    const feed = feeds.get(topic);
    return { everyMs: (d && d.autoMs) || 0, nextAt: (feed && feed.autoNextAt) || null, running: !!(feed && feed.running) };
  }

  // The interval in force: the slow one when the feed opted in and nobody is looking at it.
  function effectiveInterval(feed) {
    const bg = feed.def.backgroundIntervalMs;
    if (!bg) return feed.intervalMs;
    for (const sub of feed.subscribers) if (sub.active) return feed.intervalMs;
    return bg;
  }

  function nextDelay(feed) {
    const every = effectiveInterval(feed);
    if (feed.failures === 0) return every;
    return Math.min(every * 2 ** feed.failures, MAX_BACKOFF_MS);
  }

  // Subscribers' visibility changed: pull the next run forward (someone is looking, data is old) or push it back.
  function reschedule(feed) {
    if (feed.def.onDemand) {
      if (feed.def.autoMs && !feed.running && !(feed.snapshot === null && feed.timer)) autoArm(feed);
      return;
    }
    if (!feed.def.backgroundIntervalMs || !feed.timer || feed.running || feed.failures > 0) return;
    const age = feed.lastRunAt ? now() - feed.lastRunAt : Infinity;
    arm(feed, Math.max(0, effectiveInterval(feed) - age));
  }

  function arm(feed, delayMs) {
    if (feed.timer) cancel(feed.timer);
    feed.timer = schedule(() => { feed.timer = null; run(feed); }, delayMs);
  }

  async function run(feed) {
    if (feed.running || feed.subscribers.size === 0) return;
    feed.running = true;
    feed.lastRunAt = now();
    try {
      const manual = feed.manualRun;
      feed.manualRun = false;
      const data = await feed.def.fetch({ ...feed.ctx, manual }); // manual = an operator pressed Refresh: bypass caches
      const hash = stableStringify(data);
      feed.failures = 0;
      const wasStale = !!feed.error;
      feed.error = null;
      feed.checkedAt = new Date(now()).toISOString();
      const changedNow = feed.hash === null || hash !== feed.hash;
      if (changedNow || wasStale) {
        const changed = changedNow && feed.hash !== null ? changedKeys(feed.snapshot, data) : changedNow ? null : [];
        if (changedNow) {
          feed.version += 1;
          feed.at = feed.checkedAt;
        }
        feed.snapshot = data;
        feed.hash = hash;
        broadcast(feed, dataEvent(feed, { changed }));
      } else {
        broadcast(feed, { type: "checked", topic: feed.topic, checkedAt: feed.checkedAt });
      }
    } catch (e) {
      feed.failures += 1;
      const first = !feed.error;
      feed.error = { message: String((e && e.message) || e), at: new Date(now()).toISOString() };
      log(`[live] ${feed.topic} fetch failed (${feed.failures}x): ${feed.error.message}`);
      if (first || feed.failures % 5 === 0) broadcast(feed, { type: "feed-error", topic: feed.topic, message: feed.error.message, at: feed.error.at, stale: feed.snapshot !== null });
    } finally {
      feed.running = false;
      feed.finished = !feed.error && feed.def.stopWhen ? !!safeStop(feed.def.stopWhen, feed.snapshot) : false;
      if (feed.def.onDemand) {
        if (feed.error && feed.snapshot === null && feed.subscribers.size > 0) arm(feed, nextDelay(feed)); // keep trying until the first read lands
        else autoArm(feed); // the central auto refresh, counted from this read
      } else if (feed.subscribers.size > 0 && !feed.finished) arm(feed, nextDelay(feed));
    }
  }

  // subscribe(topicList, send) -> unsubscribe(). Cached snapshots are sent
  // immediately; polling starts only if the topic has none running.
  function subscribe(topicList, send, ctx = {}) {
    const sub = { send, active: ctx.active !== false };
    const joined = [];
    for (const spec of topicList) {
      const r = resolve(spec, ctx);
      if (!r) continue;
      const feed = instance(r);
      joined.push(feed);
      feed.subscribers.add(sub);
      if (feed.idleTimer) { cancel(feed.idleTimer); feed.idleTimer = null; }
      if (feed.snapshot !== null) {
        try { send(dataEvent(feed, { changed: null, initial: true })); } catch (e) { feed.subscribers.delete(sub); }
      } else if (feed.error) {
        // A late joiner to a feed that has only ever failed still learns that.
        try { send({ type: "feed-error", topic: feed.topic, message: feed.error.message, at: feed.error.at, stale: false }); } catch (e) { feed.subscribers.delete(sub); }
      }
      if (feed.def.onDemand) {
        if (!feed.timer && !feed.running && feed.snapshot === null) arm(feed, 0); // the first read; later ones only when asked
        else if (!feed.timer && !feed.running) autoArm(feed); // or on the central auto refresh, if one is set
      } else if (!feed.timer && !feed.running && !feed.finished) {
        const age = feed.lastRunAt ? now() - feed.lastRunAt : Infinity;
        const every = effectiveInterval(feed);
        arm(feed, age >= every ? 0 : every - age);
      }
    }
    function unsubscribe() {
      for (const feed of joined) {
        feed.subscribers.delete(sub);
        reschedule(feed);
        if (feed.subscribers.size === 0 && !feed.idleTimer) {
          feed.idleTimer = schedule(() => {
            feed.idleTimer = null;
            if (feed.subscribers.size === 0) {
              if (feed.timer) { cancel(feed.timer); feed.timer = null; }
              feed.autoNextAt = null;
              if (feed.def.scope !== "shared" && !feed.running) feeds.delete(feed.id); // per-user/per-job instances don't accumulate
            }
          }, idleGraceMs);
        }
      }
    }
    // The browser reports its tab going to / coming back from the background.
    unsubscribe.setActive = (active) => {
      if (sub.active === !!active) return;
      sub.active = !!active;
      for (const feed of joined) reschedule(feed);
    };
    return unsubscribe;
  }

  // Manual "Refresh now". Rate-limited per topic so mashing the button
  // can never hammer an upstream login; returns what it did.
  function refresh(spec, ctx = {}) {
    const r = resolve(spec, ctx);
    const feed = r && feeds.get(r.id);
    if (!feed) return { ok: false, reason: r ? "no subscribers" : "unknown topic" };
    if (feed.subscribers.size === 0) return { ok: false, reason: "no subscribers" };
    if (feed.running) return { ok: true, started: false, reason: "already running" };
    feed.finished = false;
    if (now() - feed.lastRunAt < feed.minRefreshMs) return { ok: true, started: false, reason: "refreshed moments ago" };
    feed.manualRun = true;
    arm(feed, 0);
    return { ok: true, started: true };
  }

  function snapshot(topic) {
    const f = feeds.get(topic);
    return f ? { version: f.version, at: f.at, data: f.snapshot, stale: !!f.error } : null;
  }

  function stats() {
    return [...feeds.values()].map((f) => ({ topic: f.def.topic, instance: f.id, scope: f.def.scope, subscribers: f.subscribers.size, polling: !!f.timer || f.running, version: f.version, failures: f.failures }));
  }

  function closeAll() {
    for (const f of feeds.values()) {
      if (f.timer) cancel(f.timer);
      if (f.idleTimer) cancel(f.idleTimer);
      f.timer = f.idleTimer = null;
      f.subscribers.clear();
    }
  }

  return { registerFeed, markOnDemand, setAutoInterval, autoInfo, hasTopic, accepts, topics, subscribe, refresh, snapshot, stats, closeAll };
}

module.exports = { createHub, stableStringify, changedKeys };
