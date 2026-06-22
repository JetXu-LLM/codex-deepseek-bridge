import fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// Resolve a free port, preferring `preferred` (default 8787) then the next ports.
export function findAvailablePort(preferred = 8787, host = "127.0.0.1", attempts = 64) {
  const base = Number(preferred) || 8787;
  return new Promise((resolve) => {
    const tryPort = (port, remaining) => {
      const server = net.createServer();
      server.once("error", () => {
        if (remaining <= 0) {
          resolve(base);
          return;
        }
        tryPort(port + 1, remaining - 1);
      });
      server.listen(port, host, () => {
        server.close(() => resolve(port));
      });
    };
    tryPort(base, attempts);
  });
}

export function spawnDaemon({ pidFile, stdoutLog, stderrLog, execPath = process.execPath, argv, env = process.env, cwd = process.cwd() }) {
  ensureParent(pidFile);
  ensureParent(stdoutLog);
  ensureParent(stderrLog);
  const stdout = fs.openSync(stdoutLog, "a");
  const stderr = fs.openSync(stderrLog, "a");
  try {
    const child = spawn(execPath, argv, {
      cwd,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...env, DSCB_DAEMON_CHILD: "1", QUIET: "1" },
    });
    child.unref();
    fs.writeFileSync(pidFile, `${child.pid}\n`);
    return { pid: child.pid, pidFile, stdoutLog, stderrLog };
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

export function readPid(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

export function isRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopDaemon(pidFile) {
  const pid = readPid(pidFile);
  if (!pid) {
    return { stopped: false, reason: "No pid file found.", pid: 0 };
  }
  if (!isRunning(pid)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Ignore stale pid cleanup errors.
    }
    return { stopped: false, reason: "Process was already stopped.", pid };
  }
  process.kill(pid, "SIGTERM");
  return { stopped: true, pid };
}

export function parseUnixProcessList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
}

export function parseWindowsProcessList(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId),
        command: String(row.CommandLine || ""),
      }))
      .filter((row) => Number.isFinite(row.pid) && row.command);
  } catch {
    return [];
  }
}

export function isBridgeServeCommand(command) {
  const text = String(command || "");
  return /\bcodex-deepseek-bridge(?:[-_\w.]+)?\b/i.test(text) && /(?:^|\s)serve(?:\s|$)/.test(text);
}

export function listBridgeServeProcesses({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform === "win32") {
    const result = spawnSyncImpl("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      return [];
    }
    return parseWindowsProcessList(result.stdout).filter((row) => isBridgeServeCommand(row.command));
  }

  const result = spawnSyncImpl("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  return parseUnixProcessList(result.stdout).filter((row) => isBridgeServeCommand(row.command));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStopped(pids, { timeoutMs = 1500, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isRunning(pid))) {
      return true;
    }
    await sleep(pollMs);
  }
  return pids.every((pid) => !isRunning(pid));
}

export async function stopBridgeDaemons(pidFile, options = {}) {
  const currentPid = options.currentPid ?? process.pid;
  const seen = new Set();
  const stoppedPids = [];
  const pid = readPid(pidFile);
  let pidResult = { stopped: false, reason: "No pid file found.", pid: 0 };
  if (pid) {
    seen.add(pid);
    if (pid === currentPid) {
      pidResult = { stopped: false, reason: "Pid file points at the current process.", pid };
    } else if (!isRunning(pid)) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // Ignore stale pid cleanup errors.
      }
      pidResult = { stopped: false, reason: "Process was already stopped.", pid };
    } else {
      process.kill(pid, "SIGTERM");
      stoppedPids.push(pid);
      pidResult = { stopped: true, pid };
    }
  }

  const processes = listBridgeServeProcesses(options);
  for (const proc of processes) {
    if (!proc.pid || proc.pid === currentPid || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    try {
      process.kill(proc.pid, "SIGTERM");
      stoppedPids.push(proc.pid);
    } catch {
      // The process may have exited between the scan and the signal.
    }
  }

  if (stoppedPids.length) {
    await waitForStopped(stoppedPids);
  }

  return {
    stopped: stoppedPids.length > 0,
    pid: pidResult.pid,
    pids: stoppedPids,
    reason: stoppedPids.length
      ? `Stopped ${stoppedPids.length} bridge process${stoppedPids.length === 1 ? "" : "es"}.`
      : pidResult.reason,
  };
}
