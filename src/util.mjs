import crypto from "node:crypto";

export const STATE_PREFIX = "dscb1:";

export function isEnabled(value) {
  return value === true || value === "1" || value === "true" || value === "yes" || value === "on";
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeState(state) {
  return `${STATE_PREFIX}${base64UrlEncode(JSON.stringify(state))}`;
}

export function decodeState(value) {
  if (typeof value !== "string" || !value.startsWith(STATE_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(base64UrlDecode(value.slice(STATE_PREFIX.length)));
  } catch {
    return null;
  }
}

export function redactSecrets(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer REDACTED");
}

export function jsonClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
