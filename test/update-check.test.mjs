import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  checkForUpdate,
  compareSemver,
  isNewer,
  readCachedUpdate,
  updateCacheFile,
  updateCheckDisabled,
} from "../src/update-check.mjs";

test("compareSemver orders versions and pre-releases", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.3.0", "1.2.9"), 1);
  assert.equal(compareSemver("1.2.0", "1.2.1"), -1);
  assert.equal(compareSemver("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(isNewer("2.0.0", "1.9.9"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
});

test("update check off-switches are honored", () => {
  assert.equal(updateCheckDisabled({ DSCB_UPDATE_CHECK: "off" }), true);
  assert.equal(updateCheckDisabled({ DO_NOT_TRACK: "1" }), true);
  assert.equal(updateCheckDisabled({}), false);
});

test("checkForUpdate is failure-silent when offline", async () => {
  const result = await checkForUpdate({
    env: {},
    currentVersion: "1.0.0",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result, null);
});

test("checkForUpdate returns null when disabled", async () => {
  const result = await checkForUpdate({
    env: { DSCB_UPDATE_CHECK: "off" },
    currentVersion: "1.0.0",
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v9.9.9" }) }),
  });
  assert.equal(result, null);
});

test("checkForUpdate detects a newer release and caches it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dscb-update-test-"));
  const cacheFile = path.join(root, "update-check.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ tag_name: "v2.0.0" }) };
  };

  const first = await checkForUpdate({ env: {}, currentVersion: "1.0.0", cacheFile, fetchImpl, now: Date.now() });
  assert.equal(first.latest, "2.0.0");
  assert.equal(first.updateAvailable, true);
  assert.equal(calls, 1);

  const second = await checkForUpdate({ env: {}, currentVersion: "1.0.0", cacheFile, fetchImpl, now: Date.now() });
  assert.equal(second.updateAvailable, true);
  assert.equal(calls, 1, "second call within 24h should use the cache");
});

test("readCachedUpdate reports cached release state without network", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dscb-update-cache-test-"));
  const cacheFile = updateCacheFile(root);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify({ lastCheck: "2026-06-22T00:00:00.000Z", latest: "2.0.0" })}\n`);

  const result = readCachedUpdate({ cacheFile, currentVersion: "1.0.0" });
  assert.equal(result.latest, "2.0.0");
  assert.equal(result.checkedAt, "2026-06-22T00:00:00.000Z");
  assert.equal(result.updateAvailable, true);
});
