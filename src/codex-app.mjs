import os from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_INSTALL_WAIT_MS = 60000;
const INSTALL_WAIT_POLL_MS = 1000;

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultCommandExists(command, args = ["--version"], { env = process.env } = {}) {
  try {
    const result = spawnSync(command, args, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return !result.error || result.error.code !== "ENOENT";
  } catch {
    return false;
  }
}

export function codexDesktopInstallWaitMs(env = process.env) {
  if (env.DSCB_CODEX_APP_INSTALL_WAIT_MS === "") {
    return 0;
  }
  if (env.DSCB_CODEX_APP_INSTALL_WAIT_MS != null) {
    const value = Number(env.DSCB_CODEX_APP_INSTALL_WAIT_MS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INSTALL_WAIT_MS;
  }
  return DEFAULT_INSTALL_WAIT_MS;
}

export function codexDesktopInstallPlan({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  commandExists = defaultCommandExists,
} = {}) {
  if (platform === "darwin") {
    const workspace = env.HOME || homeDir;
    const command = "codex";
    const args = ["app", workspace];
    return {
      supported: true,
      platform,
      command,
      args,
      displayCommand: 'codex app "$HOME"',
      available: commandExists(command, ["--version"], { env, platform }),
      unavailableReason: "the Codex CLI (`codex`) is not on PATH",
    };
  }

  if (platform === "win32") {
    const command = "winget";
    const args = [
      "install",
      "Codex",
      "-s",
      "msstore",
      "--accept-source-agreements",
      "--accept-package-agreements",
    ];
    return {
      supported: true,
      platform,
      command,
      args,
      displayCommand: "winget install Codex -s msstore --accept-source-agreements --accept-package-agreements",
      available: commandExists(command, ["--version"], { env, platform }),
      unavailableReason: "winget is not on PATH",
    };
  }

  return {
    supported: false,
    platform,
    command: "",
    args: [],
    displayCommand: "",
    available: false,
    unavailableReason: "automatic Codex Desktop install is only available on macOS and Windows",
  };
}

export function installCodexDesktopApp({ plan, env = process.env, spawn = spawnSync } = {}) {
  if (!plan?.supported) {
    return { ok: false, status: -1, reason: plan?.unavailableReason || "unsupported platform" };
  }
  if (!plan.available) {
    return { ok: false, status: -1, reason: plan.unavailableReason || `${plan.command} is not available` };
  }

  const result = spawn(plan.command, plan.args, {
    env,
    stdio: "inherit",
  });
  if (typeof result.status === "number") {
    return {
      ok: result.status === 0,
      status: result.status,
      signal: result.signal || "",
      reason: result.status === 0 ? "" : `${plan.command} exited with status ${result.status}`,
    };
  }
  if (result.signal) {
    return { ok: false, status: -1, signal: result.signal, reason: `${plan.command} stopped by ${result.signal}` };
  }
  return {
    ok: false,
    status: -1,
    signal: "",
    reason: result.error ? result.error.message : `${plan.command} did not finish`,
  };
}

export function waitForCodexDesktop({
  inspect,
  timeoutMs = DEFAULT_INSTALL_WAIT_MS,
  pollMs = INSTALL_WAIT_POLL_MS,
  sleep = sleepSync,
} = {}) {
  if (typeof inspect !== "function") {
    return { status: "missing" };
  }
  let current = inspect();
  if (current?.status !== "missing" || timeoutMs <= 0) {
    return current;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    current = inspect();
    if (current?.status !== "missing") {
      return current;
    }
  }
  return current;
}
