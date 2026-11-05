const crypto = require("node:crypto");
const db = require("../db");
const config = require("../../config");
const { parseStored } = require("../domain/panels");

const COOKIE_NAME = "aso_session";

async function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  await db.execute(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, user.id, new Date().toISOString(), expiresAt]
  );
  return { token, expiresAt };
}

async function getUserForToken(token) {
  if (!token) return null;
  await db.execute("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
  const rows = await db.query(
    `SELECT s.token, s.expires_at, u.id, u.employee_id, u.role, u.panels
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.deleted_at IS NULL`,
    [token, new Date().toISOString()]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, employeeId: row.employee_id, role: row.role, panels: parseStored(row.panels) };
}

async function destroySession(token) {
  await db.execute("DELETE FROM sessions WHERE token = ?", [token]);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, expiresAt) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (config.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

module.exports = {
  COOKIE_NAME,
  createSession,
  getUserForToken,
  destroySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
};
