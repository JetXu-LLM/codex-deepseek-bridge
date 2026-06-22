import test from "node:test";
import assert from "node:assert/strict";
import {
  codexDesktopInstallPlan,
  codexDesktopInstallWaitMs,
  installCodexDesktopApp,
  waitForCodexDesktop,
} from "../src/codex-app.mjs";

test("macOS Codex Desktop install plan uses the official Codex CLI app command", () => {
  const plan = codexDesktopInstallPlan({
    platform: "darwin",
    env: { HOME: "/Users/example" },
    commandExists: () => true,
  });

  assert.equal(plan.supported, true);
  assert.equal(plan.available, true);
  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, ["app", "/Users/example"]);
  assert.equal(plan.displayCommand, 'codex app "$HOME"');
});

test("Windows Codex Desktop install plan uses the Microsoft Store winget command", () => {
  const plan = codexDesktopInstallPlan({
    platform: "win32",
    commandExists: () => true,
  });

  assert.equal(plan.supported, true);
  assert.equal(plan.available, true);
  assert.equal(plan.command, "winget");
  assert.deepEqual(plan.args, [
    "install",
    "Codex",
    "-s",
    "msstore",
    "--accept-source-agreements",
    "--accept-package-agreements",
  ]);
});

test("Codex Desktop auto-install is unsupported outside macOS and Windows", () => {
  const plan = codexDesktopInstallPlan({ platform: "linux" });

  assert.equal(plan.supported, false);
  assert.equal(plan.available, false);
  assert.match(plan.unavailableReason, /macOS and Windows/);
});

test("installCodexDesktopApp runs the selected install command without a shell", () => {
  const calls = [];
  const result = installCodexDesktopApp({
    plan: {
      supported: true,
      available: true,
      command: "codex",
      args: ["app", "/tmp"],
      displayCommand: 'codex app "$HOME"',
    },
    env: { PATH: "/bin" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["app", "/tmp"]);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].options.env.PATH, "/bin");
});

test("waitForCodexDesktop polls until the Desktop app appears", () => {
  const statuses = [{ status: "missing" }, { status: "missing" }, { status: "patchable" }];
  const sleeps = [];
  const result = waitForCodexDesktop({
    inspect: () => statuses.shift() || { status: "patchable" },
    timeoutMs: 5000,
    pollMs: 1000,
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(result.status, "patchable");
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("Codex Desktop install wait can be disabled or overridden", () => {
  assert.equal(codexDesktopInstallWaitMs({ DSCB_CODEX_APP_INSTALL_WAIT_MS: "" }), 0);
  assert.equal(codexDesktopInstallWaitMs({ DSCB_CODEX_APP_INSTALL_WAIT_MS: "2500" }), 2500);
  assert.equal(codexDesktopInstallWaitMs({ DSCB_CODEX_APP_INSTALL_WAIT_MS: "bad" }), 60000);
});
