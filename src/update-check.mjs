import fs from "node:fs";
import path from "node:path";
import { isEnabled } from "./util.mjs";

export const DEFAULT_RELEASE_REPO = "JetXu-LLM/codex-deepseek-bridge";
const DAY_MS = 24 * 60 * 60 * 1000;

// Off-switches: DSCB_UPDATE_CHECK=off and the standard DO_NOT_TRACK=1 (doc 09 §3).
export function updateCheckDisabled(env = process.env) {
  return env.DSCB_UPDATE_CHECK === "off" || isEnabled(env.DO_NOT_TRACK);
}

export function releaseRepo(env = process.env) {
  return env.DSCB_RELEASE_REPO || DEFAULT_RELEASE_REPO;
}

export function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

// Semver-ish compare. Returns 1 if a > b, -1 if a < b, 0 if equal. A version
// with a pre-release suffix (1.0.0-rc.1) is lower than its release (1.0.0).
export function compareSemver(a, b) {
  const parse = (value) => {
    const [core, pre] = normalizeVersion(value).split("-");
    const nums = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    while (nums.length < 3) {
      nums.push(0);
    }
    return { nums, pre: pre || "" };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) {
      return left.nums[i] > right.nums[i] ? 1 : -1;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (!left.pre) {
    return 1;
  }
  if (!right.pre) {
    return -1;
  }
  return left.pre > right.pre ? 1 : -1;
}

export function isNewer(latest, current) {
  return compareSemver(latest, current) > 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // Cache write failures are non-fatal.
  }
}

export function updateCacheFile(bridgeHome) {
  return path.join(bridgeHome, "update-check.json");
}

export function readCachedUpdate({ cacheFile, currentVersion } = {}) {
  const cache = cacheFile ? readJson(cacheFile) : null;
  if (!cache?.latest) {
    return null;
  }
  return {
    latest: cache.latest,
    checkedAt: cache.lastCheck || null,
    updateAvailable: isNewer(cache.latest, currentVersion),
  };
}

// Reads only public release metadata; uploads nothing (doc 07 §6b).
export async function fetchLatestRelease({ repo, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "codex-deepseek-bridge",
    },
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const json = await response.json();
  return typeof json?.tag_name === "string" ? normalizeVersion(json.tag_name) : null;
}

// Rate-limited (24h), failure-silent, off-capable update check.
export async function checkForUpdate({
  env = process.env,
  currentVersion,
  repo = releaseRepo(env),
  cacheFile,
  now = Date.now(),
  ttlMs = DAY_MS,
  fetchImpl = fetch,
  force = false,
} = {}) {
  if (updateCheckDisabled(env)) {
    return null;
  }
  const cache = cacheFile ? readJson(cacheFile) : null;
  if (!force && cache?.lastCheck) {
    const age = now - Date.parse(cache.lastCheck);
    if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
      if (!cache.latest) {
        return null;
      }
      return { latest: cache.latest, updateAvailable: isNewer(cache.latest, currentVersion) };
    }
  }
  try {
    const latest = await fetchLatestRelease({ repo, fetchImpl });
    if (cacheFile) {
      writeJson(cacheFile, { lastCheck: new Date(now).toISOString(), latest });
    }
    if (!latest) {
      return null;
    }
    return { latest, updateAvailable: isNewer(latest, currentVersion) };
  } catch {
    return null;
  }
}

export function updateAvailableLine(latest, current) {
  return `Update available: ${latest} (you have ${current}). Run: codex-deepseek-bridge upgrade`;
}
