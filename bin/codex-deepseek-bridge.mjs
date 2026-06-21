#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { configFromArgs, defaultBridgeHome, defaultCodexHome, parseArgs } from "../src/config.mjs";
import { findAvailablePort, isRunning, readPid, spawnDaemon, stopDaemon } from "../src/daemon.mjs";
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
  updateAvailableLine,
  updateCheckDisabled,
} from "../src/update-check.mjs";
import { downloadVerifiedAsset, rollbackBinary, stageBinarySwap } from "../src/upgrade.mjs";
import { buildCacheReport, defaultLogFile, formatCacheReport, loadJsonl } from "../src/cache-report.mjs";
import { inspectCodexDesktopPatch, patchCodexDesktop, restoreCodexDesktopPatch } from "../src/desktop-patch.mjs";

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
  codex-deepseek-bridge setup [--from-stdin] [--port 8787] [--no-start] [--desktop-patch] [--no-desktop-patch] [--print-prompt]
  codex-deepseek-bridge start [--port 8787]
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

// Re-launch the foreground server detached. Handles both node and SEA binary.
function daemonLaunch(extraArgs) {
  const isBinary = typeof globalThis.__DSCB_VERSION__ === "string" && globalThis.__DSCB_VERSION__;
  if (isBinary || !process.argv[1]) {
    return { execPath: process.execPath, argv: ["serve", ...extraArgs] };
  }
  return { execPath: process.execPath, argv: [process.argv[1], "serve", ...extraArgs] };
}

function launchDaemon(config, port, env) {
  const { execPath, argv } = daemonLaunch(["--port", String(port)]);
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
  const cacheFile = path.join(bridgeHome, "update-check.json");
  const result = await checkForUpdate({ env, currentVersion, cacheFile });
  if (result?.updateAvailable) {
    out(updateAvailableLine(result.latest, currentVersion));
  }
}

// ---- setup ------------------------------------------------------------------

function historyLine(result) {
  if (result?.historyPreserved) {
    if (result.providerMode === "openai_base_url") {
      return "History: OpenAI-provider local history should stay visible through the official openai_base_url path.";
    }
    return `History: local history for provider ${result.providerId} should stay visible.`;
  }
  return "History: existing chats are unchanged and return after restore, but chats under another provider may be hidden while DeepSeek is active.";
}

function catalogIncludesFlash(stateOrResult) {
  return Array.isArray(stateOrResult?.catalogModelIds) && stateOrResult.catalogModelIds.includes("deepseek-flash");
}

function setupSuccessMessage(result, started) {
  const loginMode = result.loginMode;
  const runningLine = started
    ? `Bridge running: http://localhost:${result.port}/report`
    : "Start the bridge with: codex-deepseek-bridge start";
  const modelLine = catalogIncludesFlash(result)
    ? "Next: restart Codex, then pick deepseek-pro or deepseek-flash."
    : "Next: restart Codex. Codex is configured for deepseek-pro; deepseek-flash is enabled only when the Desktop compatibility patch is active.";
  if (loginMode === "chatgpt") {
    return [
      "Configured Codex for DeepSeek. Your ChatGPT login was left unchanged.",
      historyLine(result),
      runningLine,
      modelLine,
      "Start the bridge again later with: codex-deepseek-bridge start",
    ].join("\n");
  }
  if (loginMode === "uncertain") {
    return [
      "Configured Codex for DeepSeek. I could not confirm your Codex login state, so I left it unchanged.",
      historyLine(result),
      runningLine,
      modelLine,
    ].join("\n");
  }
  if (loginMode === "api-key") {
    return [
      "Configured Codex for DeepSeek. Your existing API-key login was left unchanged.",
      historyLine(result),
      runningLine,
      modelLine,
      "Start the bridge again later with: codex-deepseek-bridge start",
    ].join("\n");
  }
  // loginMode === "none"
  return [
    "Configured Codex for DeepSeek. No Codex login was changed; the bridge will use your stored DeepSeek key.",
    historyLine(result),
    runningLine,
    modelLine,
    "Start the bridge again later with: codex-deepseek-bridge start",
    `Tip: star the repo so this command is easy to find — ${REPO_URL}`,
  ].join("\n");
}

function desktopPatchLine(result) {
  const launcher = result?.launcherPath ? ` Use the managed Windows launcher: ${result.launcherPath}` : "";
  switch (result?.status) {
    case "patched":
      return `Codex Desktop compatibility patch: applied. Restore will undo it.${launcher}`;
    case "already-patched":
      return `Codex Desktop compatibility patch: already applied.${launcher}`;
    case "disabled":
      return "Codex Desktop compatibility patch: skipped.";
    case "needs-consent":
      return "Codex Desktop compatibility patch: skipped. Run setup --desktop-patch to apply it explicitly.";
    case "unsupported":
      return "Codex Desktop compatibility patch: not supported on this platform.";
    case "missing":
      return "Codex Desktop compatibility patch: Codex Desktop app was not found.";
    case "not-writable":
      return "Codex Desktop compatibility patch: skipped because Codex.app is not writable. Grant your terminal access to modify Codex.app, then re-run setup --desktop-patch.";
    case "target-not-found":
      return "Codex Desktop compatibility patch: skipped because this Codex Desktop build was not recognized.";
    case "ambiguous":
      return "Codex Desktop compatibility patch: skipped because the Desktop bundle matched more than once.";
    case "missing-info-plist":
    case "missing-code-signature":
    case "missing-root-executable":
      return "Codex Desktop compatibility patch: skipped because the Codex Desktop app bundle is incomplete.";
    case "error":
      return result.restoreReason
        ? `Codex Desktop compatibility patch: failed (${result.reason || "unknown error"}; restore also failed: ${result.restoreReason}).`
        : `Codex Desktop compatibility patch: failed (${result.reason || "unknown error"}).`;
    case "patchable":
      return "Codex Desktop compatibility patch: available. Run setup --desktop-patch to apply it explicitly.";
    default:
      return "Codex Desktop compatibility patch: unknown state.";
  }
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
  if (result?.macCodeSignature?.adhoc && result.managedBackup === false) {
    return "Codex signature: local/ad-hoc and not managed by this bridge state. If Codex keeps asking for Keychain access, reinstall or update Codex to restore the official signature.";
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
    return { status: "needs-consent" };
  }

  return patchCodexDesktop({ env, bridgeHome });
}

async function cmdSetup(args, env, config) {
  if (args["print-prompt"] === true) {
    process.stdout.write(CODEX_SETUP_PROMPT);
    return 0;
  }

  const bridgeHome = defaultBridgeHome(env);
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
    stopDaemon(config.pidFile);
  }
  const port = await findAvailablePort(preferredPort, config.host);
  if (port !== preferredPort) {
    out(`Port ${preferredPort} is in use. Using ${port} instead and writing it into your Codex config.`);
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

  out(desktopPatchLine(desktopPatch));
  out(setupSuccessMessage(result, started));
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
    out(`Codex config: ${configState}. Codex login: ${login}. Desktop compatibility patch: ${doctorDesktopPatchText(desktopPatch)}.`);
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
      await appendUpdateLine(liveVersion, env, bridgeHome);
      return 0;
    }
    if (response.status === 401) {
      out("Live DeepSeek call failed: the DeepSeek key was rejected. Check your key.");
      return 1;
    }
    out(`Live DeepSeek call failed: DeepSeek returned ${response.status}. See the report for details.`);
    return 1;
  }

  out(
    `Bridge: ok. DeepSeek key: ${keyState}. Codex config: ${configState}. Codex login: ${login}. Desktop compatibility patch: ${doctorDesktopPatchText(desktopPatch)}.`,
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

function cmdRestore(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const stopped = stopDaemon(config.pidFile);
  const result = restoreCodexConfig({ env, backupPath: args["from-backup"] || args.backup || "" });
  const desktopRestore = restoreCodexDesktopPatch({ env, bridgeHome });
  const shouldPurge = args.purge === true;

  if (args.logout === true) {
    codexLogout();
    removeStoredKey(bridgeHome);
    const purged = shouldPurge ? purgeBridgeHome(bridgeHome) : false;
    const message = desktopRestore.changed
      ? "Restored your previous Codex config and Desktop picker, then removed the API-key login plus stored DeepSeek key. Restart Codex."
      : "Restored your previous Codex config and removed the API-key login plus stored DeepSeek key. Restart Codex.";
    out(withPurgedBridgeHome(withStoppedBridge(message, stopped), purged));
    return 0;
  }
  if (!result.changed && !desktopRestore.changed) {
    const purged = shouldPurge ? purgeBridgeHome(bridgeHome) : false;
    out(withPurgedBridgeHome(withStoppedBridge("No bridge config found. Nothing to restore.", stopped), purged));
    return 0;
  }
  const purged = shouldPurge ? purgeBridgeHome(bridgeHome) : false;
  if (desktopRestore.status === "signature-repaired") {
    const message = result.changed
      ? "Restored your previous Codex config and repaired the Codex Desktop app signature. Restart Codex to apply."
      : "Repaired the Codex Desktop app signature. Restart Codex to apply.";
    out(withPurgedBridgeHome(withStoppedBridge(message, stopped), purged));
  } else if (desktopRestore.changed && result.changed) {
    out(withPurgedBridgeHome(withStoppedBridge("Restored your previous Codex config and Desktop picker. Restart Codex to apply.", stopped), purged));
  } else if (desktopRestore.changed) {
    out(withPurgedBridgeHome(withStoppedBridge("Restored the Codex Desktop picker. Restart Codex to apply.", stopped), purged));
  } else {
    out(withPurgedBridgeHome(withStoppedBridge("Restored your previous Codex config. Restart Codex to apply.", stopped), purged));
  }
  return 0;
}

// ---- upgrade ----------------------------------------------------------------

function restartBridge(config, port, env) {
  stopDaemon(config.pidFile);
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
    const asset = await downloadVerifiedAsset({ env, version: latest, repo });
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
  restartBridge(config, reconcile.port, env);

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

function cmdStop(config) {
  const result = stopDaemon(config.pidFile);
  out(result.stopped ? `Stopped the bridge (pid ${result.pid}).` : result.reason);
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
    const cacheFile = path.join(defaultBridgeHome(env), "update-check.json");
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
      return cmdSetup(args, env, config);
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
