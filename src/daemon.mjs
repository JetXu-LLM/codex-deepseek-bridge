import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function spawnDaemon({ pidFile, stdoutLog, stderrLog, argv, env = process.env, cwd = process.cwd() }) {
  ensureParent(pidFile);
  ensureParent(stdoutLog);
  ensureParent(stderrLog);
  const stdout = fs.openSync(stdoutLog, "a");
  const stderr = fs.openSync(stderrLog, "a");
  try {
    const child = spawn(process.execPath, argv, {
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
