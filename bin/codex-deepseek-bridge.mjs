#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { configFromArgs, defaultBridgeHome, defaultCodexHome, parseArgs } from "../src/config.mjs";
import { findAvailablePort, isRunning, readPid, spawnDaemon, stopBridgeDaemons } from "../src/daemon.mjs";
import {
  codexLogout,
  codexVersion,
  configureCodex,
  detectLoginMode,
  inspectCodexInstall,
  readInstallState,
  removeStoredKey,
  restoreCodexConfig,
} from "../src/install.mjs";
import { startServer } from "../src/server.mjs";
import { bridgeVersion, detectInstallMethod } from "../src/version.mjs";
import { CODEX_SETUP_PROMPT } from "../src/prompt.mjs";
import {
  checkForUpdate,
  fetchLatestRelease,
  isNewer,
  releaseRepo,
  updateCacheFile,
  updateAvailableLine,
  updateCheckDisabled,
} from "../src/update-check.mjs";
import { downloadVerifiedAsset, rollbackBinary, stageBinarySwap } from "../src/upgrade.mjs";
import { buildCacheReport, defaultLogFile, formatCacheReport, loadJsonl } from "../src/cache-report.mjs";
import { inspectCodexDesktopPatch, patchCodexDesktop, restoreCodexDesktopPatch } from "../src/desktop-patch.mjs";
import {
  codexDesktopInstallPlan,
  codexDesktopInstallWaitMs,
  installCodexDesktopApp,
  waitForCodexDesktop,
} from "../src/codex-app.mjs";
import { createFormatter } from "../src/cli-format.mjs";

const REPO_URL = "https://github.com/JetXu-LLM/codex-deepseek-bridge";

function out(text) {
  process.stdout.write(`${text}\n`);
}

function err(text) {
  process.stderr.write(`${text}\n`);
}

function printHelp() {
  process.stdout.write(`codex-deepseek-bridge — run Codex on DeepSeek.

Usage:
  codex-deepseek-bridge setup [--from-stdin] [--port 8787] [--no-start] [--desktop-patch] [--no-desktop-patch] [--no-codex-app-install] [--log-payloads|--no-log-payloads] [--yes] [--no-upgrade-check] [--print-prompt]
  codex-deepseek-bridge start [--port 8787] [--log-payloads|--no-log-payloads]
  codex-deepseek-bridge report
  codex-deepseek-bridge doctor [--live]
  codex-deepseek-bridge restore [--from-backup <path>] [--logout] [--purge]
  codex-deepseek-bridge upgrade [--check] [--yes] [--rollback]
  codex-deepseek-bridge version
  codex-deepseek-bridge status
  codex-deepseek-bridge stop

The DeepSeek API key is read from stdin (--from-stdin) or DEEPSEEK_API_KEY only.
It is never accepted as an argument, printed, logged, or committed.
`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

// Prompt once on a TTY without echoing the typed key.
function promptForKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const prompt = "Paste your DeepSeek API key (it will not be echoed): ";
    let muted = false;
    rl._writeToOutput = (chunk) => {
      if (!muted) {
        rl.output.write(chunk);
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

// Resolve the DeepSeek key from --from-stdin, then DEEPSEEK_API_KEY, then a TTY
// prompt. Never from a positional/flag value.
async function resolveKey(args, env) {
  if (args["from-stdin"] === true) {
    return (await readStdin()).trim();
  }
  if (env.DEEPSEEK_API_KEY) {
    return String(env.DEEPSEEK_API_KEY).trim();
  }
  if (process.stdin.isTTY) {
    return (await promptForKey()).trim();
  }
  return "";
}

function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

function confirmDefaultYes(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const text = String(answer).trim();
      resolve(text === "" || /^y(es)?$/i.test(text));
    });
  });
}

// Re-launch the foreground server detached. Handles both node and SEA binary.
function daemonLaunch(extraArgs) {
  const isBinary = typeof globalThis.__DSCB_VERSION__ === "string" && globalThis.__DSCB_VERSION__;
  if (isBinary || !process.argv[1]) {
    return { execPath: process.execPath, argv: ["serve", ...extraArgs] };
  }
  return { execPath: process.execPath, argv: [process.argv[1], "serve", ...extraArgs] };
}

function daemonArgs(config, port) {
  const args = ["--port", String(port)];
  if (config.logPayloads) {
    args.push("--log-payloads");
  } else {
    args.push("--no-log-payloads");
  }
  if (config.logDir === "") {
    args.push("--log-dir", "off");
  } else if (config.logDir !== undefined) {
    args.push("--log-dir", config.logDir);
  }
  if (config.deepseekBaseUrl) {
    args.push("--deepseek-base-url", config.deepseekBaseUrl);
  }
  if (config.enableVision) {
    args.push("--vision");
  }
  return args;
}

function launchDaemon(config, port, env) {
  const { execPath, argv } = daemonLaunch(daemonArgs(config, port));
  return spawnDaemon({
    pidFile: config.pidFile,
    stdoutLog: config.stdoutLog,
    stderrLog: config.stderrLog,
    execPath,
    argv,
    env,
  });
}

function resolvedPort(args, state, config) {
  return Number(args.port || state?.port || config.port || 8787);
}

function openInBrowser(url) {
  const platform = process.platform;
  const [command, commandArgs] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function displayHost(config) {
  return config.host === "127.0.0.1" ? "localhost" : config.host;
}

function reportUrl(config, port) {
  return `http://${displayHost(config)}:${port}/report`;
}

async function waitForHealth(port, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function appendUpdateLine(currentVersion, env, bridgeHome) {
  if (updateCheckDisabled(env)) {
    return;
  }
  const cacheFile = updateCacheFile(bridgeHome);
  const result = await checkForUpdate({ env, currentVersion, cacheFile });
  if (result?.updateAvailable) {
    out(updateAvailableLine(result.latest, currentVersion));
  }
}

// ---- setup ------------------------------------------------------------------

function catalogIncludesFlash(stateOrResult) {
  return Array.isArray(stateOrResult?.catalogModelIds) && stateOrResult.catalogModelIds.includes("deepseek-flash");
}

// Concise, prefix-free history status for the setup summary section.
function historyStatusLine(result) {
  if (result?.historyPreserved) {
    if (result.providerMode === "openai_base_url") {
      return "local history stays visible through the official openai_base_url path";
    }
    return `provider ${result.providerId} history stays visible; other provider chats return after restore`;
  }
  return "existing chats are unchanged and return after restore; some chats under another provider may be hidden while DeepSeek is active";
}

function loginStatusLine(loginMode) {
  switch (loginMode) {
    case "chatgpt":
      return "ChatGPT login left unchanged";
    case "api-key":
      return "API-key login left unchanged";
    case "uncertain":
      return "login state unconfirmed, so it was left unchanged";
    default:
      return "no Codex login changed (the bridge uses your stored DeepSeek key)";
  }
}

function modelsStatusLine(result) {
  return catalogIncludesFlash(result)
    ? "deepseek-pro and deepseek-flash published to the picker"
    : "deepseek-pro active (shown as Custom unless the Desktop patch is applied)";
}

function setupUpgradeCheckSkipped(args, env) {
  return (
    args["no-upgrade-check"] === true ||
    env.DSCB_SKIP_SETUP_UPGRADE_CHECK === "1" ||
    updateCheckDisabled(env)
  );
}

function setupCommandArgs(rawArgs) {
  return ["setup", ...rawArgs];
}

function spawnSetup(command, commandArgs, env, { shell = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell,
    env: { ...env, DSCB_SKIP_SETUP_UPGRADE_CHECK: "1" },
  });
  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.signal) {
    err(`Setup stopped by ${result.signal}.`);
  } else if (result.error) {
    err(`Could not restart setup: ${result.error.message}`);
  }
  return 1;
}

function renderSetupUpgradeNotice(fmt, { current, latest, method }) {
  return fmt.section("Update available", [
    `Current  ${current}`,
    `Latest   ${latest}`,
    `Install  ${method}`,
    "Plan     upgrade first, then continue this setup command",
    "Keeps    stored key, logs, report data, and backups",
  ]);
}

function formatMiB(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MiB`;
}

function createDownloadProgressReporter(env, stream = process.stdout) {
  const enabled = env.DSCB_NO_PROGRESS !== "1";
  let printed = false;
  let lastPercent = -1;
  let lastPrintAt = 0;
  return ({ asset, received, total, done }) => {
    if (!enabled) {
      return;
    }
    const label = asset || "release asset";
    if (!stream.isTTY) {
      if (!printed) {
        out(`Downloading ${label}...`);
        printed = true;
      }
      if (done) {
        out(`Downloaded ${label} (${formatMiB(received)}).`);
      }
      return;
    }
    const now = Date.now();
    const percent = total ? Math.floor((received / total) * 100) : -1;
    if (!done && percent === lastPercent && now - lastPrintAt < 500) {
      return;
    }
    lastPercent = percent;
    lastPrintAt = now;
    const progress = total
      ? `${Math.min(percent, 100)}% (${formatMiB(received)} / ${formatMiB(total)})`
      : formatMiB(received);
    if (done) {
      stream.write(`\rDownloaded ${label} (${formatMiB(received)}).${" ".repeat(24)}\n`);
      return;
    }
    stream.write(`\rDownloading ${label} ${progress}${" ".repeat(24)}`);
  };
}

async function maybeUpgradeBeforeSetup(args, rawArgs, env, bridgeHome) {
  if (setupUpgradeCheckSkipped(args, env)) {
    return null;
  }

  const current = bridgeVersion();
  const repo = releaseRepo(env);
  const check = await checkForUpdate({
    env,
    currentVersion: current,
    repo,
    cacheFile: updateCacheFile(bridgeHome),
    force: true,
  });
  if (!check?.updateAvailable) {
    return null;
  }

  const latest = check.latest;
  const method = detectInstallMethod();
  let accepted = args.yes === true;
  let noticePrinted = false;
  if (!accepted && process.stdin.isTTY) {
    const fmt = createFormatter({ stream: process.stdout, env });
    out(renderSetupUpgradeNotice(fmt, { current, latest, method }));
    noticePrinted = true;
    accepted = await confirmDefaultYes("Upgrade now and continue setup? [Y/n] ");
  }
  if (!accepted) {
    if (!noticePrinted) {
      const fmt = createFormatter({ stream: process.stdout, env });
      out(renderSetupUpgradeNotice(fmt, { current, latest, method }));
    }
    out("Continuing setup with the current version.");
    out("To upgrade first in a non-interactive run, add --yes.");
    return null;
  }

  if (method === "source") {
    out("Source install detected. Update with: git pull && npm install");
    out("Continuing setup with the current source checkout.");
    return null;
  }

  if (method === "npm") {
    const install = spawnSync("npm", ["install", "-g", `github:${repo}`], { stdio: "inherit" });
    if (install.status !== 0) {
      err(`npm upgrade failed. Run: npm install -g github:${repo}`);
      return 1;
    }
    out(`Upgraded to ${latest}. Continuing setup with the updated CLI.`);
    return spawnSetup("codex-deepseek-bridge", setupCommandArgs(rawArgs), env, { shell: process.platform === "win32" });
  }

  const asset = await downloadVerifiedAsset({ env, version: latest, repo, onProgress: createDownloadProgressReporter(env) });
  if (!asset.ok) {
    if (asset.reason === "checksum-mismatch") {
      err("Upgrade aborted: the download did not match its checksum. Nothing was changed.");
    } else {
      err("Upgrade failed to download a verified binary. Download the latest release manually.");
    }
    return 1;
  }

  const restartArgs = setupCommandArgs(rawArgs);
  const swap = stageBinarySwap({ currentPath: process.execPath, bytes: asset.bytes, restartArgs });
  if (!swap.ok) {
    err("Upgrade failed while swapping the binary. The previous binary is unchanged.");
    return 1;
  }
  if (swap.staged) {
    out(`Upgraded to ${latest}. A helper will finish the swap and re-run setup.`);
    return 0;
  }

  out(`Upgraded to ${latest}. Continuing setup with the updated binary.`);
  return spawnSetup(process.execPath, restartArgs, env);
}

function envValueDisabled(value) {
  return ["0", "false", "off", "no", "disabled"].includes(String(value || "").trim().toLowerCase());
}

function setupExplicitDesktopPatch(args, env) {
  return args["desktop-patch"] === true || env.DSCB_DESKTOP_PATCH === "on";
}

function inspectCodexDesktopForInstall(env, bridgeHome) {
  const inspectEnv = { ...env };
  delete inspectEnv.DSCB_DESKTOP_PATCH;
  return inspectCodexDesktopPatch({ env: inspectEnv, bridgeHome });
}

function renderCodexAppInstallNotice(fmt, plan) {
  return fmt.section("Codex Desktop app not found", [
    "Setup can install the official Codex Desktop app first, then continue.",
    `Command  ${plan.displayCommand || "not available on this platform"}`,
    "Keeps    your Codex config, DeepSeek key, logs, report data, and backups",
  ]);
}

function renderCodexAppInstallUnavailable(fmt, plan) {
  const action = plan.platform === "darwin"
    ? 'Install or update the Codex CLI first, then run: codex app "$HOME"'
    : plan.platform === "win32"
      ? "Install Codex from the Microsoft Store, then re-run setup."
      : "Install Codex Desktop on macOS or Windows, then re-run setup.";
  return fmt.section("Action needed", [
    `Automatic install is not available because ${plan.unavailableReason}.`,
    action,
  ]);
}

function shouldOfferCodexAppInstall(args, env) {
  if (args["no-codex-app-install"] === true || envValueDisabled(env.DSCB_CODEX_APP_INSTALL)) {
    return false;
  }
  if (env.DSCB_CODEX_APP || env.DSCB_CODEX_APP_ASAR) {
    return false;
  }
  return args.yes === true || process.stdin.isTTY;
}

function requestCodexQuitForFreshDesktopPatch({ platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return;
  }
  try {
    spawnSync("osascript", ["-e", 'quit app "Codex"'], { stdio: "ignore" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  } catch {
    // If AppleScript is unavailable, patchCodexDesktop will report app-running
    // with the normal user-facing guidance.
  }
}

async function maybeInstallCodexDesktopBeforeSetup(args, env, bridgeHome) {
  const before = inspectCodexDesktopForInstall(env, bridgeHome);
  if (before?.status !== "missing") {
    return { attempted: false, installed: false, inspect: before };
  }
  if (!shouldOfferCodexAppInstall(args, env)) {
    return { attempted: false, installed: false, inspect: before };
  }

  const plan = codexDesktopInstallPlan({ platform: process.platform, env });
  const fmt = createFormatter({ stream: process.stdout, env });
  out(renderCodexAppInstallNotice(fmt, plan));

  if (!plan.supported || !plan.available) {
    out(renderCodexAppInstallUnavailable(fmt, plan));
    return { attempted: false, installed: false, inspect: before, unavailable: true };
  }

  const accepted = args.yes === true ? true : await confirmDefaultYes("Install Codex now and continue setup? [Y/n] ");
  if (!accepted) {
    out("Continuing setup without installing Codex Desktop.");
    return { attempted: false, installed: false, inspect: before, declined: true };
  }

  out(`Running: ${plan.displayCommand}`);
  const install = installCodexDesktopApp({ plan, env });
  if (!install.ok) {
    err(`Codex install failed: ${install.reason || "unknown error"}. Continuing config-only setup.`);
    return { attempted: true, installed: false, inspect: before, failed: true };
  }

  const waitMs = codexDesktopInstallWaitMs(env);
  if (waitMs > 0) {
    out("Waiting for Codex Desktop to finish installing...");
  }
  const after = waitForCodexDesktop({
    inspect: () => inspectCodexDesktopForInstall(env, bridgeHome),
    timeoutMs: waitMs,
  });
  if (after?.status === "missing") {
    out("Codex installer finished, but the Desktop app is not visible yet. Finish the installer, then restart Codex or re-run setup.");
    return { attempted: true, installed: false, inspect: after };
  }

  out("Codex Desktop app found. Continuing setup.");
  return { attempted: true, installed: true, inspect: after };
}

// The framed guidance shown when the Desktop patch cannot write to Codex.
function notWritableCallout(platform) {
  if (platform === "win32") {
    return [
      "Action needed: the Desktop patch was skipped.",
      "",
      "Codex could not be modified, usually because it is still running.",
      "",
      "To enable it:",
      "  1. Quit Codex completely",
      "  2. Re-run: codex-deepseek-bridge setup --desktop-patch",
      "",
      "deepseek-pro already works without the patch -- it only adds deepseek-flash and the full model picker.",
    ];
  }
  return [
    "Action needed: the Desktop patch was skipped.",
    "",
    "Codex.app could not be modified. On macOS this is almost always App Management protection, not a file-permission problem.",
    "",
    "To enable it:",
    "  1. Open System Settings > Privacy & Security > App Management",
    "  2. Turn on your terminal (Terminal, iTerm, or your editor)",
    "  3. Re-run: codex-deepseek-bridge setup --desktop-patch",
    "",
    "sudo does not help here. deepseek-pro already works without the patch -- it only adds deepseek-flash and the full model picker.",
  ];
}

// Render the Desktop-patch outcome as its own block: a quiet one-liner for
// expected states, a highlighted box when the user needs to act.
function renderDesktopPatch(result, fmt, platform) {
  const head = fmt.label.bold("Desktop compatibility patch");
  const indented = (text) => [head, `  ${text}`].join("\n");
  const launcher = result?.launcherPath ? `Managed launcher: ${result.launcherPath}` : "";
  switch (result?.status) {
    case "patched":
    case "already-patched": {
      const items = [
        fmt.label.ok(
          result.status === "patched"
            ? "applied -- restart Codex for deepseek-flash and the full picker"
            : "already applied",
        ),
      ];
      if (launcher) {
        items.push(launcher);
      }
      if (platform === "darwin") {
        items.push(
          fmt.label.warn(
            "macOS will ask to allow Keychain access (Codex is now signed locally) -- click Always Allow. Reinstalling or updating Codex restores the original signature.",
          ),
        );
      }
      return [head, ...items.map((item) => `  ${item}`)].join("\n");
    }
    case "needs-consent":
    case "patchable": {
      const items = [
        fmt.label.dim(
          "not applied. Custom is ready and routes to deepseek-pro; for named deepseek-pro/deepseek-flash picker entries, re-run: setup --desktop-patch",
        ),
      ];
      if (platform === "darwin" && result?.macCodeSignature?.adhoc) {
        items.push(
          fmt.label.warn(
            "Codex.app is already signed locally; plain setup did not change it. Restore with bridge backups or reinstall/update Codex to stop Keychain prompts.",
          ),
        );
      }
      return [head, ...items.map((item) => `  ${item}`)].join("\n");
    }
    case "disabled":
      return indented(fmt.label.dim("skipped (--no-desktop-patch)"));
    case "unsupported":
      return indented(fmt.label.dim("not needed on this platform"));
    case "missing":
      return indented(fmt.label.dim("Codex Desktop app not found; config-only deepseek-pro still works"));
    case "target-not-found":
      return indented(fmt.label.dim("skipped: this Codex Desktop build was not recognized"));
    case "ambiguous":
      return indented(fmt.label.dim("skipped: more than one Codex Desktop bundle matched"));
    case "missing-info-plist":
    case "missing-code-signature":
    case "missing-root-executable":
      return indented(fmt.label.dim("skipped: the Codex Desktop bundle looks incomplete"));
    case "app-running":
      return [
        head,
        fmt.box([
          "Action needed: quit Codex first.",
          "",
          "The Desktop patch changes Codex app files, so the bridge left them untouched while Codex was running.",
          "",
          "To enable it:",
          "  1. Quit Codex completely",
          "  2. Re-run: codex-deepseek-bridge setup --desktop-patch",
          "",
          "Custom still routes to deepseek-pro without the patch.",
        ], { tone: "red" }),
      ].join("\n");
    case "not-writable":
      return [head, fmt.box(notWritableCallout(platform), { tone: "red" })].join("\n");
    case "error": {
      const lines = ["Action needed: the Desktop patch failed.", "", `Reason: ${result.reason || "unknown error"}.`];
      if (result.restoreReason) {
        lines.push(`Restore also failed: ${result.restoreReason}.`);
      }
      if (String(result.errorCode) === "EPERM" && platform === "darwin") {
        lines.push(
          "",
          "This looks like macOS App Management. Open System Settings > Privacy & Security > App Management, enable your terminal, then re-run. sudo does not help.",
        );
      }
      lines.push("", "deepseek-pro already works without the patch.");
      return [head, fmt.box(lines, { tone: "red" })].join("\n");
    }
    default:
      return indented(fmt.label.dim("unknown state"));
  }
}

// Compose the whole setup summary: a banner, labeled sections, and the
// Desktop-patch outcome (highlighted when action is required).
function renderSetupReport(fmt, { result, started, desktopPatch, platform }) {
  const kv = (key, value) => `${key.padEnd(8)} ${value}`;
  const running = started
    ? fmt.label.ok(`running -> http://localhost:${result.port}/report`)
    : fmt.label.warn("not started (run: codex-deepseek-bridge start)");
  const fullPicker = catalogIncludesFlash(result);
  const blocks = [
    fmt.title("Codex DeepSeek Bridge  -  setup complete"),
    fmt.section("Bridge", [kv("Status", running), kv("Key", "DeepSeek key stored on this machine")]),
    fmt.section("Codex", [
      kv("Models", modelsStatusLine(result)),
      kv("Login", loginStatusLine(result.loginMode)),
      kv("History", historyStatusLine(result)),
    ]),
    renderDesktopPatch(desktopPatch, fmt, platform),
    fmt.section("Next steps", [
      "1. Restart Codex",
      fullPicker
        ? "2. Pick deepseek-pro or deepseek-flash in the model picker"
        : "2. Pick Custom in the model picker; it routes to deepseek-pro",
      "3. Watch traffic and cache stats: codex-deepseek-bridge report",
    ]),
  ];
  if (result.loginMode === "none") {
    blocks.push(fmt.label.dim(`Tip: star the repo so this is easy to find again -- ${REPO_URL}`));
  }
  return blocks.filter(Boolean).join("\n\n");
}

function doctorDesktopPatchText(result) {
  switch (result?.status) {
    case "patched":
    case "already-patched":
      return result.managedBackup === false ? "patched (not managed by this install)" : "patched";
    case "patchable":
      return "needs setup";
    case "disabled":
      return "disabled";
    case "unsupported":
      return "not needed on this platform";
    case "missing":
      return "Codex Desktop app not found";
    case "target-not-found":
      return "unrecognized Desktop build";
    case "ambiguous":
      return "ambiguous Desktop bundle";
    case "error":
      return `error (${result.reason || "unknown"})`;
    default:
      return result?.status || "unknown";
  }
}

function doctorSignatureLine(result) {
  if (result?.macCodeSignature?.adhoc) {
    if (result.managedBackup === false) {
      return "Codex signature: local/ad-hoc and not managed by this bridge. If Codex keeps asking for Keychain access, reinstall or update Codex to restore the official signature.";
    }
    return "Codex signature: local/ad-hoc because the Desktop patch is active, so macOS may ask for Keychain access on launch. Run restore to return to the original signature, or click Always Allow.";
  }
  return "";
}

async function maybePatchCodexDesktop(args, env, bridgeHome) {
  if (args["no-desktop-patch"] === true || env.DSCB_DESKTOP_PATCH === "off") {
    return { status: "disabled" };
  }

  const inspect = inspectCodexDesktopPatch({ env, bridgeHome });
  if (inspect.status !== "patchable") {
    return inspect;
  }

  const explicit = args["desktop-patch"] === true || env.DSCB_DESKTOP_PATCH === "on";
  if (!explicit) {
    return { ...inspect, status: "needs-consent" };
  }

  try {
    return await patchCodexDesktop({ env, bridgeHome });
  } catch (error) {
    // A patch failure (for example a read-only Codex.app) must never surface a raw
    // stack trace; report it as a clean status the CLI can render.
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function cmdSetup(args, env, config, rawArgs = []) {
  if (args["print-prompt"] === true) {
    process.stdout.write(CODEX_SETUP_PROMPT);
    return 0;
  }

  const bridgeHome = defaultBridgeHome(env);
  const upgradeCode = await maybeUpgradeBeforeSetup(args, rawArgs, env, bridgeHome);
  if (upgradeCode != null) {
    return upgradeCode;
  }

  const hasStoredKey = inspectCodexInstall({ env, bridgeHome }).keyStored;
  const explicitKeySource = args["from-stdin"] === true || Boolean(env.DEEPSEEK_API_KEY);
  const key = explicitKeySource || !hasStoredKey ? await resolveKey(args, env) : "";
  if (!key) {
    if (!hasStoredKey) {
      out("No DeepSeek API key was provided.");
      out("Re-run setup in a terminal: codex-deepseek-bridge setup");
      out("It will ask you to paste your key without echoing it.");
      out("Your key is stored locally and never printed or committed.");
      return 0;
    }
    out("Using the DeepSeek key already stored on this machine.");
  }

  const preferredPort = Number(args.port || 8787);
  if (args["no-start"] !== true) {
    await stopBridgeDaemons(config.pidFile);
  }
  const port = await findAvailablePort(preferredPort, config.host);
  if (port !== preferredPort) {
    out(`Port ${preferredPort} is in use. Using ${port} instead and writing it into your Codex config.`);
  }

  const codexAppInstall = await maybeInstallCodexDesktopBeforeSetup(args, env, bridgeHome);
  if (codexAppInstall.installed && setupExplicitDesktopPatch(args, env)) {
    requestCodexQuitForFreshDesktopPatch({ platform: process.platform });
  }

  const desktopPatch = await maybePatchCodexDesktop(args, env, bridgeHome);
  const includeFlash = new Set(["patched", "already-patched"]).has(desktopPatch?.status);

  const result = configureCodex({
    env,
    apiKey: key,
    host: config.host,
    port,
    vision: config.enableVision,
    includeFlash,
    installMethod: detectInstallMethod(),
    bridgeVersion: bridgeVersion(),
  });

  let started = false;
  if (args["no-start"] !== true) {
    launchDaemon(config, port, env);
    started = true;
  }

  out(renderSetupReport(createFormatter({ stream: process.stdout, env }), {
    result,
    started,
    desktopPatch,
    platform: process.platform,
  }));
  await appendUpdateLine(bridgeVersion(), env, bridgeHome);
  return 0;
}

// ---- start ------------------------------------------------------------------

async function cmdStart(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const existingPid = readPid(config.pidFile);
  if (isRunning(existingPid)) {
    out(`Bridge already running on http://${displayHost(config)}:${state?.port || config.port}.`);
    return 0;
  }

  const preferredPort = Number(args.port || state?.port || 8787);
  const port = await findAvailablePort(preferredPort, config.host);
  if (state && port !== state.port) {
    // Reconcile the config to the port we will actually bind (preserve key/login).
      configureCodex({
        env,
        apiKey: "",
        host: config.host,
        port,
        vision: config.enableVision,
        includeFlash: catalogIncludesFlash(state),
        installMethod: state.installMethod || detectInstallMethod(),
        bridgeVersion: bridgeVersion(),
        adaptLogin: false,
    });
  }
  launchDaemon(config, port, env);
  out(`Bridge started on http://${displayHost(config)}:${port} (report at /report).`);
  return 0;
}

// ---- report -----------------------------------------------------------------

async function cmdReport(args, env, config) {
  const state = readInstallState(defaultBridgeHome(env));
  const port = resolvedPort(args, state, config);
  const url = reportUrl(config, port);
  const pid = readPid(config.pidFile);
  let started = false;
  if (!isRunning(pid)) {
    launchDaemon(config, port, env);
    started = true;
    await waitForHealth(port);
  }
  if (openInBrowser(url)) {
    out(started ? `Started the bridge and opening ${url}` : `Opening ${url}`);
  } else {
    out(url);
  }
  return 0;
}

// ---- doctor -----------------------------------------------------------------

async function cmdDoctor(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const port = resolvedPort(args, state, config);
  const report = reportUrl(config, port);
  const inspect = inspectCodexInstall({ env });
  const keyState = inspect.keyStored || env.DEEPSEEK_API_KEY ? "stored" : "missing";
  const configState = inspect.managedBlockPresent ? "DeepSeek active" : "not configured";
  const login = inspect.state?.loginMode || detectLoginMode({ env });
  const desktopPatch = inspectCodexDesktopPatch({ env, bridgeHome });

  let healthOk = false;
  let liveVersion = bridgeVersion();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    healthOk = response.ok;
    const json = await response.json().catch(() => ({}));
    if (json && typeof json.version === "string") {
      liveVersion = json.version;
    }
  } catch {
    healthOk = false;
  }

  if (!healthOk) {
    out("Bridge: offline. Start it with: codex-deepseek-bridge start");
    out(`DeepSeek key: ${keyState}. Codex config: ${configState}. Codex login: ${login}. Desktop compatibility patch: ${doctorDesktopPatchText(desktopPatch)}.`);
    out(`Report: ${report} (available after the bridge starts).`);
    const signatureLine = doctorSignatureLine(desktopPatch);
    if (signatureLine) {
      out(signatureLine);
    }
    return 1;
  }

  if (args.live === true) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-pro",
          input: "Reply with exactly: bridge-ok",
          stream: false,
          reasoning: { effort: "high" },
        }),
      });
    } catch {
      out("Bridge: offline. Start it with: codex-deepseek-bridge start");
      return 1;
    }
    if (response.status === 200) {
      out("Live DeepSeek call: ok. Model: deepseek-pro. Reply received.");
      out(`Report: ${report}`);
      await appendUpdateLine(liveVersion, env, bridgeHome);
      return 0;
    }
    if (response.status === 401) {
      out("Live DeepSeek call failed: the DeepSeek key was rejected. Check your key.");
      out(`Report: ${report}`);
      return 1;
    }
    out(`Live DeepSeek call failed: DeepSeek returned ${response.status}. See ${report} for details.`);
    return 1;
  }

  out(`Bridge: ok on http://${displayHost(config)}:${port}. Report: ${report}.`);
  out(
    `DeepSeek key: ${keyState}. Codex config: ${configState}. Codex login: ${login}. Desktop compatibility patch: ${doctorDesktopPatchText(desktopPatch)}.`,
  );
  const signatureLine = doctorSignatureLine(desktopPatch);
  if (signatureLine) {
    out(signatureLine);
  }
  if (login === "api-key") {
    out(
      inspect.state?.historyPreserved
        ? `History note: local history for provider ${inspect.state.providerId || "the selected provider"} should stay visible. ChatGPT cloud-only history still requires ChatGPT sign-in.`
        : "History note: chats under another provider may be hidden while DeepSeek is active, but restore brings the previous config back.",
    );
  }
  await appendUpdateLine(liveVersion, env, bridgeHome);
  return 0;
}

// ---- restore ----------------------------------------------------------------

function withStoppedBridge(message, stopped) {
  return stopped?.stopped ? `${message} Stopped the bridge.` : message;
}

function purgeBridgeHome(bridgeHome) {
  try {
    fs.rmSync(bridgeHome, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function withPurgedBridgeHome(message, purged) {
  return purged ? `${message} Removed bridge state, stored key, logs, and backups.` : message;
}

function desktopRestoreNeedsState(result) {
  return new Set([
    "app-changed",
    "app-running",
    "error",
    "missing-backup",
    "missing-signature-backup",
    "signature-restore-failed",
  ]).has(result?.status);
}

function purgeBridgeHomeAfterRestore(bridgeHome, shouldPurge, desktopRestore) {
  if (!shouldPurge) {
    return { purged: false, skipped: false };
  }
  if (desktopRestoreNeedsState(desktopRestore)) {
    return { purged: false, skipped: true };
  }
  return { purged: purgeBridgeHome(bridgeHome), skipped: false };
}

function restoreAttentionLine(desktopRestore, purgeResult) {
  const prefix = purgeResult?.skipped ? "Note: kept bridge backups because restore needs them. " : "Note: ";
  switch (desktopRestore?.status) {
    case "signature-restore-failed":
      return `${prefix}Codex Desktop's original signature could not be fully accepted by macOS, and the bridge did not locally re-sign it. Reinstall or update Codex from the official source to stop Keychain prompts.`;
    case "missing-signature-backup":
      return `${prefix}Codex Desktop signature backups are missing. Reinstall or update Codex from the official source to stop Keychain prompts.`;
    case "missing-backup":
      return `${prefix}Codex Desktop backup is missing. Reinstall or update Codex from the official source to stop Keychain prompts.`;
    case "app-changed":
      return `${prefix}Codex Desktop changed after the patch, so the bridge left it alone. Reinstall or update Codex from the official source if Keychain prompts remain.`;
    case "app-running":
      return `${prefix}Codex was still running, so the bridge left the Desktop app files unchanged. Quit Codex completely, then re-run restore.`;
    case "unmanaged-local-signature":
      return `${prefix}Codex.app is locally signed but not managed by this bridge. Reinstall or update Codex from the official source to stop Keychain prompts.`;
    case "error":
      return `${prefix}the Codex Desktop app could not be modified (${desktopRestore.reason || "unknown error"}). If Keychain prompts remain, reinstall or update Codex.`;
    default:
      return purgeResult?.skipped ? "Note: kept bridge backups because the Desktop app was not fully restored." : "";
  }
}

function printRestoreMessage(message, stopped, purgeResult, desktopRestore) {
  out(withPurgedBridgeHome(withStoppedBridge(message, stopped), purgeResult.purged));
  const attention = restoreAttentionLine(desktopRestore, purgeResult);
  if (attention) {
    out(attention);
  }
}

function desktopRestoreLine(desktopRestore, fmt) {
  switch (desktopRestore?.status) {
    case "restored":
      return fmt.label.ok(desktopRestore.restoreCodesignStabilized ? "restored; macOS accepted" : "restored");
    case "signature-repaired":
      return fmt.label.ok("official signature repaired");
    case "not-managed":
      return fmt.label.dim("not active");
    case "unmanaged-local-signature":
      return fmt.label.warn("local signature is not managed by this bridge");
    case "missing-backup":
    case "missing-signature-backup":
    case "signature-restore-failed":
    case "app-changed":
    case "app-running":
    case "error":
      return fmt.label.warn("needs attention; see note below");
    default:
      return desktopRestore?.changed ? fmt.label.ok("restored") : fmt.label.dim("not active");
  }
}

function renderRestoreReport(fmt, { result, desktopRestore, stopped, purgeResult, logout }) {
  const configChanged = Boolean(result?.changed);
  const desktopChanged = Boolean(desktopRestore?.changed);
  const anyChanged = configChanged || desktopChanged || logout || purgeResult?.purged;
  const kv = (key, value) => `${key.padEnd(8)} ${value}`;
  const configLine = result?.removedConfig
    ? fmt.label.ok("original no-config state restored")
    : configChanged
      ? fmt.label.ok("previous config restored")
      : fmt.label.dim("no bridge config found");
  const nextSteps = desktopRestore?.status === "app-running"
    ? ["1. Quit Codex completely", "2. Re-run: codex-deepseek-bridge restore"]
    : anyChanged
      ? ["1. Restart Codex", "2. Open Codex with your previous configuration"]
      : ["No restart needed unless Codex was already open."];
  const blocks = [
    fmt.title(anyChanged ? "Codex DeepSeek Bridge  -  restore complete" : "Codex DeepSeek Bridge  -  nothing to restore"),
    fmt.section("Codex", [
      kv("Config", configLine),
      kv("Desktop", desktopRestoreLine(desktopRestore, fmt)),
      kv("Login", logout ? fmt.label.ok("API-key login removed") : "left unchanged"),
    ]),
    fmt.section("Bridge", [
      kv("Process", stopped?.stopped ? fmt.label.ok("stopped") : fmt.label.dim(stopped?.reason || "not running")),
      kv("Key", logout || purgeResult?.purged ? fmt.label.ok("removed") : "kept for future setup runs"),
      kv("Data", purgeResult?.purged ? fmt.label.ok("removed logs, backups, and bridge state") : "logs, backups, and report data kept"),
    ]),
  ];

  const attention = restoreAttentionLine(desktopRestore, purgeResult);
  if (attention) {
    blocks.push(fmt.section("Note", [fmt.label.warn(attention)]));
  }

  blocks.push(fmt.section("Next steps", nextSteps));

  return blocks.filter(Boolean).join("\n\n");
}

async function cmdRestore(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const stopped = await stopBridgeDaemons(config.pidFile);
  const result = restoreCodexConfig({ env, backupPath: args["from-backup"] || args.backup || "" });
  let desktopRestore;
  try {
    desktopRestore = restoreCodexDesktopPatch({ env, bridgeHome });
  } catch (error) {
    // Never surface a raw stack if the Desktop app is read-only; the config
    // restore below is the part that matters most.
    desktopRestore = { changed: false, status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (desktopRestore.status === "not-managed") {
    const desktopInspect = inspectCodexDesktopPatch({ env, bridgeHome });
    if (desktopInspect?.macCodeSignature?.adhoc) {
      desktopRestore = { ...desktopRestore, status: "unmanaged-local-signature" };
    }
  }
  const shouldPurge = args.purge === true;
  const purgeResult = purgeBridgeHomeAfterRestore(bridgeHome, shouldPurge, desktopRestore);
  const fmt = createFormatter({ stream: process.stdout, env });

  if (args.logout === true) {
    codexLogout();
    removeStoredKey(bridgeHome);
    out(renderRestoreReport(fmt, { result, desktopRestore, stopped, purgeResult, logout: true }));
    return 0;
  }
  out(renderRestoreReport(fmt, { result, desktopRestore, stopped, purgeResult, logout: false }));
  return 0;
}

// ---- upgrade ----------------------------------------------------------------

async function restartBridge(config, port, env) {
  await stopBridgeDaemons(config.pidFile);
  launchDaemon(config, port, env);
}

async function cmdUpgrade(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const method = state?.installMethod || detectInstallMethod();
  const current = bridgeVersion();
  const repo = releaseRepo(env);

  if (args.rollback === true) {
    if (method !== "binary") {
      out(`Roll back with: npm install -g codex-deepseek-bridge@${state?.previousVersion || "<previousVersion>"}`);
      return 0;
    }
    const result = rollbackBinary({ currentPath: process.execPath });
    if (!result.ok) {
      err("Rollback failed: no previous binary was found.");
      return 1;
    }
    out("Rolled back to the previous binary.");
    return 0;
  }

  let latest = null;
  try {
    latest = await fetchLatestRelease({ repo });
  } catch {
    latest = null;
  }

  if (args.check === true) {
    if (!latest) {
      out(`codex-deepseek-bridge ${current} (via ${method}). Latest: unknown (could not reach GitHub).`);
      return 1;
    }
    if (isNewer(latest, current)) {
      out(`codex-deepseek-bridge ${current} (via ${method}). Latest: ${latest}. Run: codex-deepseek-bridge upgrade`);
    } else {
      out(`codex-deepseek-bridge ${current} (via ${method}). Latest: ${latest}. Up to date.`);
    }
    return 0;
  }

  if (!latest) {
    err("Could not reach GitHub to check for updates.");
    return 1;
  }
  if (!isNewer(latest, current)) {
    out("Already up to date.");
    return 0;
  }
  if (args.yes !== true) {
    const ok = await confirm(`Upgrade codex-deepseek-bridge ${current} -> ${latest}? [y/N] `);
    if (!ok) {
      out("Upgrade cancelled.");
      return 0;
    }
  }

  if (method === "source") {
    out("Source install detected. Update with: git pull && npm install");
    return 0;
  }

  if (method === "npm") {
    const result = spawnSync("npm", ["install", "-g", `github:${repo}`], { stdio: "inherit" });
    if (result.status !== 0) {
      err(`npm upgrade failed. Run: npm install -g github:${repo}`);
      return 1;
    }
  } else if (method === "binary") {
    const asset = await downloadVerifiedAsset({ env, version: latest, repo, onProgress: createDownloadProgressReporter(env) });
    if (!asset.ok) {
      if (asset.reason === "checksum-mismatch") {
        err("Upgrade aborted: the download did not match its checksum. Nothing was changed.");
      } else {
        err("Upgrade failed to download a verified binary. Download the latest release manually.");
      }
      return 1;
    }
    const swap = stageBinarySwap({ currentPath: process.execPath, bytes: asset.bytes });
    if (!swap.ok) {
      err("Upgrade failed while swapping the binary. The previous binary is unchanged.");
      return 1;
    }
    if (swap.staged) {
      out(`Upgraded to ${latest}. The bridge will restart to finish the update.`);
      return 0;
    }
  }

  const port = state?.port || config.port || 8787;
  const currentDesktopPatch = inspectCodexDesktopPatch({ env, bridgeHome });
  const desktopPatch =
    currentDesktopPatch.state?.active || env.DSCB_DESKTOP_PATCH === "on"
      ? patchCodexDesktop({ env, bridgeHome })
      : currentDesktopPatch;
  const includeFlash = new Set(["patched", "already-patched"]).has(desktopPatch?.status) || catalogIncludesFlash(state);
  const reconcile = configureCodex({
    env,
    apiKey: "",
    host: config.host,
    port,
    vision: config.enableVision,
    includeFlash,
    installMethod: method,
    bridgeVersion: latest,
    adaptLogin: false,
  });
  await restartBridge(config, reconcile.port, env);

  if (reconcile.catalogChanged || desktopPatch.status === "patched") {
    out(`Upgraded to ${latest}. Bridge restarted. Restart Codex to pick up the model catalog and picker state.`);
  } else {
    out(`Upgraded to ${latest}. Bridge restarted on http://${displayHost(config)}:${reconcile.port}.`);
  }
  out(`Changelog: ${REPO_URL}/releases/tag/v${latest}`);
  return 0;
}

// ---- version / status / stop ------------------------------------------------

async function cmdVersion(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const version = bridgeVersion();
  const port = state?.port || config.port;
  const codex = codexVersion() || "not found";
  out(`codex-deepseek-bridge ${version} | port ${port} | codex ${codex}`);
  await appendUpdateLine(version, env, bridgeHome);
  return 0;
}

async function cmdStatus(env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const port = state?.port || config.port;
  const running = isRunning(readPid(config.pidFile));
  if (running) {
    out(`Bridge running on http://${displayHost(config)}:${port} (report at /report).`);
  } else {
    out("Bridge not running. Start it with: codex-deepseek-bridge start");
  }
  await appendUpdateLine(bridgeVersion(), env, bridgeHome);
  return running ? 0 : 1;
}

async function cmdStop(config) {
  const result = await stopBridgeDaemons(config.pidFile);
  out(result.stopped ? `Stopped the bridge (${result.pids.join(", ")}).` : result.reason);
  return 0;
}

// ---- serve (internal/foreground) --------------------------------------------

async function cmdServe(config, env) {
  const state = readInstallState(defaultBridgeHome(env));
  config.includeFlash = catalogIncludesFlash(state);
  fs.mkdirSync(path.dirname(config.pidFile), { recursive: true });
  fs.writeFileSync(config.pidFile, `${process.pid}\n`);
  const server = await startServer(config);

  // Background update check: once after start, then at most once per 24h.
  if (!updateCheckDisabled(env)) {
    const cacheFile = updateCacheFile(defaultBridgeHome(env));
    checkForUpdate({ env, currentVersion: bridgeVersion(), cacheFile }).catch(() => {});
  }

  const shutdown = () => {
    server.close(() => {
      try {
        fs.unlinkSync(config.pidFile);
      } catch {
        // Ignore stale pid cleanup errors.
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

// ---- cache-report (hidden/advanced) -----------------------------------------

function cmdCacheReport(config, args) {
  const file = args.file || args["log-file"] || defaultLogFile(config);
  if (!file || !fs.existsSync(file)) {
    err(`Log file not found: ${file || "(none configured)"}`);
    return 1;
  }
  process.stdout.write(formatCacheReport(buildCacheReport(loadJsonl(file)), file));
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "help";
  const args = parseArgs(argv.slice(1));
  const env = process.env;
  const config = configFromArgs(args, env);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "setup":
      return cmdSetup(args, env, config, argv.slice(1));
    case "start":
      return cmdStart(args, env, config);
    case "report":
    case "open-report":
      return cmdReport(args, env, config);
    case "doctor":
      return cmdDoctor(args, env, config);
    case "restore":
      return cmdRestore(args, env, config);
    case "upgrade":
      return cmdUpgrade(args, env, config);
    case "version":
    case "--version":
      return cmdVersion(args, env, config);
    case "status":
      return cmdStatus(env, config);
    case "stop":
      return cmdStop(config);
    case "serve":
      return cmdServe(config, env);
    case "cache-report":
      return cmdCacheReport(config, args);
    default:
      err(`Unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
