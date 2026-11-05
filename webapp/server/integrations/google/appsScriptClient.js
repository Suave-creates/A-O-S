// Server-side client for the existing Google Apps Script web app. This is the
// ONLY place APPS_SCRIPT_KEY is read. It must never be forwarded to a route
// response, logged in full, or referenced from anything under public/.
//
// Reuses the same "getAsrsDump" action the extension's fetchAsrsDump()
// already calls (background/index.js) - same endpoint, same response shape.
// Google Sheets/Apps Script itself is NOT modified or migrated by this file.

const config = require("../../config");

// Bearer header for a domain-restricted web app, from the configured
// authorized_user credentials file (refreshes the access token as needed).
let cachedAuth = null;
async function defaultAuthHeaders(keyFile) {
  if (!cachedAuth || cachedAuth.keyFile !== keyFile) {
    const { GoogleAuth } = require("google-auth-library");
    cachedAuth = { keyFile, auth: new GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }) };
  }
  const client = await cachedAuth.auth.getClient();
  const h = await client.getRequestHeaders();
  // Newer google-auth-library versions return a Headers instance, older a plain object.
  return typeof h.get === "function" ? { Authorization: h.get("authorization") } : { Authorization: h.Authorization };
}

async function fetchAsrsDump(signal) {
  if (!config.appsScriptUrl) {
    const err = new Error(
      "APPS_SCRIPT_URL is not configured on the backend (see webapp/.env.example)."
    );
    err.code = "APPS_SCRIPT_NOT_CONFIGURED";
    throw err;
  }

  const url = new URL(config.appsScriptUrl);
  url.searchParams.set("action", "getAsrsDump");
  if (config.appsScriptKey) url.searchParams.set("secret", config.appsScriptKey);

  const headers = { Accept: "application/json" };
  if (config.appsScriptAuthCredentialsPath) {
    try {
      Object.assign(headers, await defaultAuthHeaders(config.appsScriptAuthCredentialsPath));
    } catch (e) {
      const err = new Error(`Apps Script Google sign-in failed: ${e.message || e}. Re-run the Google login that created APPS_SCRIPT_AUTH_CREDENTIALS_PATH.`);
      err.code = "APPS_SCRIPT_AUTH_ERROR";
      throw err;
    }
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers,
      signal,
    });
  } catch (e) {
    // Let cancellation (AbortError) and the timeout (TimeoutError) propagate
    // as-is so the caller (toteUtilisationJob) can tell them apart from a
    // genuine network failure and set the right query status.
    if (e.name === "AbortError" || e.name === "TimeoutError") throw e;
    const err = new Error(`Apps Script request failed: ${e.message || e}`);
    err.code = "APPS_SCRIPT_NETWORK_ERROR";
    throw err;
  }

  if (!resp.ok) {
    const err = new Error(`Apps Script returned HTTP ${resp.status}`);
    err.code = "APPS_SCRIPT_HTTP_ERROR";
    throw err;
  }

  let data;
  let text = "";
  try {
    text = await resp.text();
    data = JSON.parse(text);
  } catch (e) {
    if (/accounts\.google\.com|Sign in - Google Accounts|AccountChooser/i.test(text)) {
      const err = new Error(
        "Apps Script returned a Google sign-in page: the web app is restricted to your Workspace domain. Set APPS_SCRIPT_AUTH_CREDENTIALS_PATH to a domain account's Google credentials file (see .env.example)."
      );
      err.code = "APPS_SCRIPT_SIGNIN_REQUIRED";
      throw err;
    }
    const err = new Error("Apps Script response was not valid JSON");
    err.code = "APPS_SCRIPT_BAD_JSON";
    throw err;
  }

  if (!data.ok) {
    const err = new Error(data.reason || data.error || "Apps Script returned ok:false");
    err.code = "APPS_SCRIPT_ERROR_RESPONSE";
    throw err;
  }

  return data.rows || [];
}

module.exports = { fetchAsrsDump };
