import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { releaseRepo } from "./update-check.mjs";

// macOS + Windows are the only shipped binary targets (doc 05 §3).
export function releaseAssetName(platform = process.platform, arch = process.arch) {
  if (platform === "win32") {
    return "codex-deepseek-bridge-win-x64.exe";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "codex-deepseek-bridge-macos-arm64" : "codex-deepseek-bridge-macos-x64";
  }
  return null;
}

export function assetUrl(repo, version, asset) {
  return `https://github.com/${repo}/releases/download/v${version}/${asset}`;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function downloadBuffer(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { "user-agent": "codex-deepseek-bridge" } });
  if (!response.ok) {
    throw new Error(`download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Download the release asset, verify its .sha256, and abort on any mismatch.
// Returns the verified bytes; never writes anything on failure.
export async function downloadVerifiedAsset({
  env = process.env,
  version,
  platform = process.platform,
  arch = process.arch,
  repo = releaseRepo(env),
  fetchImpl = fetch,
} = {}) {
  const asset = releaseAssetName(platform, arch);
  if (!asset) {
    return { ok: false, reason: "unsupported-platform" };
  }
  const url = assetUrl(repo, version, asset);
  let bytes;
  try {
    bytes = await downloadBuffer(url, fetchImpl);
  } catch (error) {
    return { ok: false, reason: "download-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  let expected;
  try {
    const sumText = (await (await fetchImpl(`${url}.sha256`, { headers: { "user-agent": "codex-deepseek-bridge" } })).text()).trim();
    expected = sumText.split(/\s+/)[0].toLowerCase();
  } catch {
    return { ok: false, reason: "checksum-unavailable" };
  }
  const actual = sha256(bytes).toLowerCase();
  if (!expected || expected !== actual) {
    return { ok: false, reason: "checksum-mismatch", expected, actual };
  }
  return { ok: true, asset, url, bytes };
}

// Stage the swap and keep the previous binary for rollback (doc 09 §5).
// macOS: atomic rename in place. Windows: a one-shot helper swaps after exit.
export function stageBinarySwap({ currentPath, bytes, platform = process.platform, restartArgs = ["start"] }) {
  const dir = path.dirname(currentPath);
  const base = path.basename(currentPath);
  const newPath = path.join(dir, `${base}.new`);
  const prevPath = path.join(dir, platform === "win32" ? `${base}.prev.exe` : `${base}.prev`);
  fs.writeFileSync(newPath, bytes);

  if (platform === "win32") {
    const helper = path.join(dir, "dscb-upgrade.cmd");
    const script = [
      "@echo off",
      "ping 127.0.0.1 -n 2 >nul",
      `move /Y "${currentPath}" "${prevPath}" >nul`,
      `move /Y "${newPath}" "${currentPath}" >nul`,
      `start "" "${currentPath}" ${restartArgs.join(" ")}`,
    ].join("\r\n");
    fs.writeFileSync(helper, script);
    const child = spawn("cmd", ["/c", helper], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, staged: true, prevPath, helper };
  }

  fs.chmodSync(newPath, 0o755);
  try {
    fs.renameSync(currentPath, prevPath);
    fs.renameSync(newPath, currentPath);
  } catch (error) {
    return { ok: false, reason: "swap-failed", detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, staged: false, prevPath };
}

// Roll back to the kept previous binary (binary installs only).
export function rollbackBinary({ currentPath, platform = process.platform }) {
  const dir = path.dirname(currentPath);
  const base = path.basename(currentPath);
  const prevPath = path.join(dir, platform === "win32" ? `${base}.prev.exe` : `${base}.prev`);
  if (!fs.existsSync(prevPath)) {
    return { ok: false, reason: "no-previous-binary" };
  }
  try {
    fs.renameSync(prevPath, currentPath);
    if (platform !== "win32") {
      fs.chmodSync(currentPath, 0o755);
    }
    return { ok: true, restoredFrom: prevPath };
  } catch (error) {
    return { ok: false, reason: "rollback-failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
