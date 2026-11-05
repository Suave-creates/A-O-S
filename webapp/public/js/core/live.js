// Live client: ONE EventSource per browser tab, shared by every screen.
//
//   const off = Live.subscribe("dashboard.aisle", (evt) => { ... });  // later: off()
//
// evt = { type: "data" | "checked" | "feed-error", topic, data, changed, at,
//         checkedAt, stale, initial, message }
//   - "data"       the snapshot changed (or this is the first/cached snapshot,
//                  `initial: true`). `changed` = top-level keys that moved
//                  (null when unknown) so screens can animate just those.
//   - "checked"    server re-checked, nothing changed (freshness tick only).
//   - "feed-error" the server's upstream fetch failed; the last data is stale.
//
// The browser never causes an upstream fetch or a service login: it only
// listens to what the server's live hub pushes (server/live/liveHub.js).
// The stream stays open in a background tab (operators work in other apps with ASO beside them and must
// keep getting live data, alerts and the siren). Only a stream that died while hidden is reopened on return.
const Live = (() => {
  const subs = new Map(); // topic -> Set(handler)
  const lastData = new Map(); // topic -> last "data" event (replayed to late subscribers)
  const stateListeners = new Set();
  let source = null;
  let state = "idle"; // idle | connecting | live | reconnecting | paused
  let connectTimer = null;
  const queuedRefresh = new Set(); // refresh requests made before the stream is subscribed server-side
  let retryTimer = null;
  let retryDelay = 3000;
  const sid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); // names this tab's stream to the server

  function setState(next) {
    if (state === next) return;
    const prev = state;
    state = next;
    if (typeof Toast !== "undefined") {
      if (next === "reconnecting" && prev === "live") Toast.show({ title: "Live updates interrupted", message: "Reconnecting - the data shown may be stale.", tone: "warn" });
      else if (next === "live" && prev === "reconnecting") Toast.show({ title: "Live updates restored", tone: "ok", ms: 2500 });
    }
    stateListeners.forEach((fn) => { try { fn(state); } catch (e) { /* listener bug must not break the stream */ } });
  }

  function dispatch(evt) {
    if (evt.type === "data") lastData.set(evt.topic, evt);
    const set = subs.get(evt.topic);
    if (!set) return;
    set.forEach((fn) => { try { fn(evt); } catch (e) { console.warn("[live] handler error:", e.message); } });
  }

  function close() {
    if (source) { source.close(); source = null; }
    clearTimeout(retryTimer);
  }

  // intentional = the topic set changed (a screen opened/closed): keep showing
  // "live" through the quick reopen instead of flashing a false "reconnecting".
  function open(intentional = false) {
    close();
    const topics = [...subs.keys()];
    if (topics.length === 0) { setState("idle"); return; }
    if (!(intentional && state === "live")) setState(state === "live" ? "reconnecting" : "connecting");
    source = new EventSource("/api/v1/live/stream?topics=" + encodeURIComponent(topics.join(",")) + "&sid=" + sid + (document.hidden ? "&visible=0" : ""));
    source.onopen = () => {
      retryDelay = 3000;
      setState("live");
      // The server subscribes this stream's topics as it opens it, so queued
      // "refresh now" requests can go out safely.
      const q = [...queuedRefresh];
      queuedRefresh.clear();
      q.forEach((t) => Api.post("/live/refresh", { topic: t }).catch(() => {}));
    };
    for (const type of ["data", "checked", "feed-error"]) {
      source.addEventListener(type, (e) => { try { dispatch(JSON.parse(e.data)); } catch (err) { /* malformed frame - ignore */ } });
    }
    source.onerror = () => {
      // EventSource retries by itself while readyState is CONNECTING; a
      // CLOSED source (401 after logout, 429 cap, server restart mid-handshake)
      // needs a manual reopen with backoff.
      if (source && source.readyState === EventSource.CLOSED) {
        setState("reconnecting");
        retryTimer = setTimeout(open, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      } else {
        setState("reconnecting");
      }
    };
  }

  // Topic set changed - coalesce bursts (a screen subscribing to 4 topics) into one reconnect.
  function scheduleOpen() {
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => { connectTimer = null; open(true); }, 40);
  }

  function subscribe(topic, handler) {
    let set = subs.get(topic);
    const isNewTopic = !set;
    if (!set) { set = new Set(); subs.set(topic, set); }
    set.add(handler);
    const cached = lastData.get(topic);
    if (cached) { try { handler({ ...cached, initial: true, changed: null }); } catch (e) { /* ignore */ } }
    if (isNewTopic) scheduleOpen();
    return function unsubscribe() {
      const s = subs.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) { subs.delete(topic); scheduleOpen(); }
    };
  }

  function onState(fn) {
    stateListeners.add(fn);
    fn(state);
    return () => stateListeners.delete(fn);
  }

  // Manual "refresh now" - asks the SERVER hub to re-run the feed (rate-limited
  // there); the fresh snapshot arrives over the stream like any other change.
  async function refresh(topic) {
    if (state !== "live" || connectTimer) {
      queuedRefresh.add(topic); // sent as soon as the stream is open and subscribed
      return { ok: true, queued: true };
    }
    try {
      return await Api.post("/live/refresh", { topic });
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  document.addEventListener("visibilitychange", () => {
    // Tell the server whether anyone is looking: background-only topics refresh slowly (see liveHub.js).
    if (source && state === "live") Api.post("/live/visibility", { sid, visible: !document.hidden }).catch(() => {});
    if (!document.hidden && subs.size && (!source || source.readyState === EventSource.CLOSED)) open();
  });

  // Restart the animation on an element (re-adding the class alone won't).
  function flash(el, cls = "live-flash") {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // Replace a table body's HTML but animate only the cells whose text actually
  // changed (the "see exactly what moved" effect). First render fades in;
  // identical HTML is a no-op; a structural change (row count) just swaps.
  function setHtml(el, html) {
    if (!el || el.dataset.liveHtml === html) return false;
    const first = el.dataset.liveHtml === undefined;
    const before = [...el.querySelectorAll("td")].map((td) => td.textContent);
    el.innerHTML = html;
    el.dataset.liveHtml = html;
    if (first) { flash(el, "live-appear"); return true; }
    const cells = [...el.querySelectorAll("td")];
    if (cells.length === before.length) cells.forEach((td, i) => { if (td.textContent !== before[i]) flash(td, "cell-flash"); });
    else flash(el, "live-appear");
    return true;
  }

  // Follow one job's progress: fn(evt) is called for every event and returns
  // true when the job is finished, which unsubscribes (the server also stops
  // polling that job). Returns a cancel function. Replaces client polling:
  //   stop = Live.watch("query:" + id, (evt) => { ...; return isTerminal; });
  function watch(topic, fn) {
    let off = null;
    let done = false;
    off = subscribe(topic, (evt) => {
      if (done) return;
      if (fn(evt) === true) {
        done = true;
        setTimeout(() => off && off(), 0); // off may not be assigned yet for a cached first event
      }
    });
    return () => { done = true; if (off) off(); };
  }

  // the topics this page is subscribed to right now (the open screen's, plus the app-wide alert list)
  const topics = () => [...subs.keys()];

  return { subscribe, watch, onState, refresh, topics, flash, setHtml, get state() { return state; } };
})();
