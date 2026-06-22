import test from "node:test";
import assert from "node:assert/strict";
import { assetUrl, downloadVerifiedAsset, releaseAssetName, sha256, windowsCmdArg } from "../src/upgrade.mjs";

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

test("downloadVerifiedAsset reports streaming download progress", async () => {
  const partA = Buffer.from("fake-");
  const partB = Buffer.from("binary-content");
  const bytes = Buffer.concat([partA, partB]);
  const good = sha256(bytes);
  const progress = [];
  const fetchImpl = async (url) => {
    if (url.endsWith(".sha256")) {
      return { ok: true, text: async () => `${good}  asset` };
    }
    return {
      ok: true,
      headers: { get: (name) => (name === "content-length" ? String(bytes.length) : "") },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(partA);
          controller.enqueue(partB);
          controller.close();
        },
      }),
    };
  };
  const result = await downloadVerifiedAsset({
    version: "2.0.0",
    platform: "darwin",
    arch: "arm64",
    repo: "x/y",
    fetchImpl,
    onProgress: (entry) => progress.push(entry),
  });

  assert.equal(result.ok, true);
  assert.equal(progress.at(-1).done, true);
  assert.equal(progress.at(-1).received, bytes.length);
  assert.equal(progress.at(-1).total, bytes.length);
  assert.ok(progress.length >= 3);
});

test("downloadVerifiedAsset rejects unsupported platforms", async () => {
  const result = await downloadVerifiedAsset({ version: "2.0.0", platform: "linux", arch: "x64", repo: "x/y", fetchImpl: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-platform");
});

test("windowsCmdArg quotes restart arguments for the upgrade helper", () => {
  assert.equal(windowsCmdArg("--desktop-patch"), "--desktop-patch");
  assert.equal(windowsCmdArg("https://example.com/a?b=1&c=2"), "\"https://example.com/a?b=1&c=2\"");
  assert.equal(windowsCmdArg("has space"), "\"has space\"");
});
