import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isBridgeServeCommand,
  listBridgeServeProcesses,
  parseUnixProcessList,
  parseWindowsProcessList,
  stopBridgeDaemons,
} from "../src/daemon.mjs";

test("detects only codex-deepseek-bridge serve commands", () => {
  assert.equal(isBridgeServeCommand("/Users/me/codex-deepseek-bridge-macos serve --port 8788"), true);
  assert.equal(isBridgeServeCommand("node /repo/bin/codex-deepseek-bridge.mjs serve --port 8787"), true);
  assert.equal(isBridgeServeCommand("C:\\Tools\\codex-deepseek-bridge-win-x64.exe serve --port 8787"), true);
  assert.equal(isBridgeServeCommand("/Users/me/codex-deepseek-bridge-macos setup"), false);
  assert.equal(isBridgeServeCommand("/Applications/Codex.app/Contents/Resources/codex serve"), false);
  assert.equal(isBridgeServeCommand("/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"), false);
});

test("parses and filters Unix bridge serve processes", () => {
  const stdout = [
    "  101 /Users/me/codex-deepseek-bridge-macos serve --port 8788",
    "  102 /Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl",
    "  103 node /repo/bin/codex-deepseek-bridge.mjs setup",
    "  104 node /repo/bin/codex-deepseek-bridge.mjs serve --port 8787",
  ].join("\n");

  assert.deepEqual(parseUnixProcessList(stdout).map((row) => row.pid), [101, 102, 103, 104]);
  const rows = listBridgeServeProcesses({
    platform: "darwin",
    spawnSyncImpl: () => ({ status: 0, stdout }),
  });
  assert.deepEqual(rows.map((row) => row.pid), [101, 104]);
});

test("parses and filters Windows bridge serve processes", () => {
  const stdout = JSON.stringify([
    { ProcessId: 201, CommandLine: "C:\\Tools\\codex-deepseek-bridge-win-x64.exe serve --port 8787" },
    { ProcessId: 202, CommandLine: "C:\\Program Files\\Codex\\Codex.exe" },
    { ProcessId: 203, CommandLine: "C:\\Tools\\codex-deepseek-bridge-win-x64.exe setup" },
  ]);

  assert.deepEqual(parseWindowsProcessList(stdout).map((row) => row.pid), [201, 202, 203]);
  const rows = listBridgeServeProcesses({
    platform: "win32",
    spawnSyncImpl: () => ({ status: 0, stdout }),
  });
  assert.deepEqual(rows.map((row) => row.pid), [201]);
});

test("does not stop the current process when the pid file points at itself", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dscb-daemon-test-"));
  const pidFile = path.join(root, "bridge.pid");
  fs.writeFileSync(pidFile, `${process.pid}\n`);

  const result = await stopBridgeDaemons(pidFile, {
    currentPid: process.pid,
    platform: "darwin",
    spawnSyncImpl: () => ({ status: 0, stdout: "" }),
  });

  assert.equal(result.stopped, false);
  assert.equal(result.pid, process.pid);
  assert.equal(result.reason, "Pid file points at the current process.");
});
