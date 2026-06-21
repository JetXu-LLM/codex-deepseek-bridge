import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The bridge version is the npm package version. For the self-contained binary
// (doc 05/09) the build injects the same value as globalThis.__DSCB_VERSION__ so
// the binary knows its own version with no package.json on disk.
export function bridgeVersion() {
  if (typeof globalThis.__DSCB_VERSION__ === "string" && globalThis.__DSCB_VERSION__) {
    return globalThis.__DSCB_VERSION__;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Deterministic install-method detection, recorded once at setup time (doc 09 §2).
export function detectInstallMethod() {
  if (typeof globalThis.__DSCB_VERSION__ === "string" && globalThis.__DSCB_VERSION__) {
    return "binary";
  }
  const url = String(import.meta.url || "");
  if (url.includes(`node_modules${path.sep}codex-deepseek-bridge`) || url.includes("node_modules/codex-deepseek-bridge")) {
    return "npm";
  }
  return "source";
}
