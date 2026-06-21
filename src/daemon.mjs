import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
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
