export function normalizeDeepSeekKey(value) {
  return String(value || "").trim();
}

export function validateDeepSeekKey(value) {
  const key = normalizeDeepSeekKey(value);
  if (!key) {
    return { ok: false, key, reason: "missing" };
  }
  if (/[^\x21-\x7e]/.test(key)) {
    return { ok: false, key, reason: "characters" };
  }
  return { ok: true, key };
}

export function deepSeekKeyValidationMessage(result) {
  if (result?.reason === "characters") {
    return "That does not look like a DeepSeek API key. Use the plain ASCII key from DeepSeek; spaces, line breaks, and full-width characters are not allowed.";
  }
  return "That does not look like a DeepSeek API key. Paste the key from DeepSeek without spaces or line breaks.";
}
