// Tiny fetch wrapper. No API keys or secrets ever live in this file or
// anywhere else under public/ - the browser only ever talks to our own
// backend at /api/v1/*, which is the sole holder of the Apps Script Script
// Key (see webapp/server/config.js + server/lib/appsScriptClient.js).
const Api = (() => {
  async function call(method, path, body) {
    const res = await fetch("/api/v1" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data; // additive - existing callers only ever read .message/.status
      throw err;
    }
    return data;
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    del: (path) => call("DELETE", path),
  };
})();
