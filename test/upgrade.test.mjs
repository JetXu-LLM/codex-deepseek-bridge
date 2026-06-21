import test from "node:test";
import assert from "node:assert/strict";
import { assetUrl, downloadVerifiedAsset, releaseAssetName, sha256 } from "../src/upgrade.mjs";

test("releaseAssetName maps the shipped targets only", () => {
  assert.equal(releaseAssetName("darwin", "arm64"), "codex-deepseek-bridge-macos");
  assert.equal(releaseAssetName("darwin", "x64"), "codex-deepseek-bridge-macos-x64");
  assert.equal(releaseAssetName("win32", "x64"), "codex-deepseek-bridge-win-x64.exe");
  assert.equal(releaseAssetName("linux", "x64"), null);
});

test("assetUrl points at the tagged GitHub release asset", () => {
  assert.equal(
    assetUrl("JetXu-LLM/codex-deepseek-bridge", "2.0.0", "codex-deepseek-bridge-macos"),
    "https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/download/v2.0.0/codex-deepseek-bridge-macos",
  );
});

test("downloadVerifiedAsset aborts on a checksum mismatch", async () => {
  const bytes = Buffer.from("fake-binary-content");
  const fetchImpl = async (url) => {
    if (url.endsWith(".sha256")) {
      return { ok: true, text: async () => "deadbeefdeadbeef  asset" };
    }
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const result = await downloadVerifiedAsset({ version: "2.0.0", platform: "darwin", arch: "arm64", repo: "x/y", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "checksum-mismatch");
});

test("downloadVerifiedAsset returns verified bytes on a checksum match", async () => {
  const bytes = Buffer.from("fake-binary-content");
  const good = sha256(bytes);
  const fetchImpl = async (url) => {
    if (url.endsWith(".sha256")) {
      return { ok: true, text: async () => `${good}  asset` };
    }
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const result = await downloadVerifiedAsset({ version: "2.0.0", platform: "darwin", arch: "arm64", repo: "x/y", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(Buffer.compare(result.bytes, bytes), 0);
});

test("downloadVerifiedAsset rejects unsupported platforms", async () => {
  const result = await downloadVerifiedAsset({ version: "2.0.0", platform: "linux", arch: "x64", repo: "x/y", fetchImpl: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-platform");
});
