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
  codex-deepseek-bridge setup [--from-stdin] [--port 8787] [--no-start] [--print-prompt]
  codex-deepseek-bridge start [--port 8787]
  codex-deepseek-bridge report
  codex-deepseek-bridge doctor [--live]
  codex-deepseek-bridge restore [--from-backup <path>] [--logout]
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

function setupSuccessMessage(loginMode, port, started) {
  const runningLine = started
    ? `Bridge running: http://127.0.0.1:${port}/report`
    : "Start the bridge with: codex-deepseek-bridge start";
  if (loginMode === "chatgpt") {
    return [
      "Configured Codex for DeepSeek. Your ChatGPT login was left unchanged, so your Codex history stays available.",
      runningLine,
      "Start the bridge again later with: codex-deepseek-bridge start",
    ].join("\n");
  }
  if (loginMode === "uncertain") {
    return [
      "Configured Codex for DeepSeek. I could not confirm your Codex login state, so I left it unchanged.",
      runningLine,
      "Next: restart Codex, then pick deepseek-pro or deepseek-flash.",
    ].join("\n");
  }
  if (loginMode === "api-key") {
    return [
      "Configured Codex for DeepSeek. Your existing API-key login was left unchanged.",
      "Note: API-key login cannot show ChatGPT-backed history. To recover that history, run codex-deepseek-bridge restore --logout and sign in to Codex with ChatGPT.",
      runningLine,
      "Next: restart Codex, then pick deepseek-pro or deepseek-flash.",
      "Start the bridge again later with: codex-deepseek-bridge start",
    ].join("\n");
  }
  // loginMode === "none"
  return [
    "Configured Codex for DeepSeek. No Codex login was changed; the bridge will use your stored DeepSeek key.",
    runningLine,
    "Next: restart Codex, then pick deepseek-pro or deepseek-flash.",
    "Start the bridge again later with: codex-deepseek-bridge start",
    `Tip: star the repo so this command is easy to find — ${REPO_URL}`,
  ].join("\n");
}

async function cmdSetup(args, env, config) {
  if (args["print-prompt"] === true) {
    process.stdout.write(CODEX_SETUP_PROMPT);
    return 0;
  }

  const key = await resolveKey(args, env);
  const bridgeHome = defaultBridgeHome(env);
  const hasStoredKey = inspectCodexInstall({ env, bridgeHome }).keyStored;
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
  const port = await findAvailablePort(preferredPort, config.host);
  if (port !== preferredPort) {
    out(`Port ${preferredPort} is in use. Using ${port} instead and writing it into your Codex config.`);
  }

  const result = configureCodex({
    env,
    apiKey: key,
    host: config.host,
    port,
    vision: config.enableVision,
    installMethod: detectInstallMethod(),
    bridgeVersion: bridgeVersion(),
  });

  let started = false;
  if (args["no-start"] !== true) {
    launchDaemon(config, port, env);
    started = true;
  }

  out(setupSuccessMessage(result.loginMode, port, started));
  await appendUpdateLine(bridgeVersion(), env, bridgeHome);
  return 0;
}

// ---- start ------------------------------------------------------------------

async function cmdStart(args, env, config) {
  const bridgeHome = defaultBridgeHome(env);
  const state = readInstallState(bridgeHome);
  const existingPid = readPid(config.pidFile);
  if (isRunning(existingPid)) {
    out(`Bridge already running on http://127.0.0.1:${state?.port || config.port}.`);
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
      installMethod: state.installMethod || detectInstallMethod(),
      bridgeVersion: bridgeVersion(),
      adaptLogin: false,
    });
  }
  launchDaemon(config, port, env);
  out(`Bridge started on http://127.0.0.1:${port} (report at /report).`);
  return 0;
}

// ---- report -----------------------------------------------------------------

function cmdReport(args, env, config) {
  const state = readInstallState(defaultBridgeHome(env));
  const port = resolvedPort(args, state, config);
  const url = `http://127.0.0.1:${port}/report`;
  if (openInBrowser(url)) {
    out(`Opening ${url}`);
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

  const inspect = inspectCodexInstall({ env });
  const keyState = inspect.keyStored || env.DEEPSEEK_API_KEY ? "stored" : "missing";
  const configState = inspect.managedBlockPresent ? "DeepSeek active" : "not configured";
  const login = inspect.state?.loginMode || detectLoginMode({ env });
  out(`Bridge: ok. DeepSeek key: ${keyState}. Codex config: ${configState}. Codex login: ${login}.`);
  await appendUpdateLine(liveVersion, env, bridgeHome);
  return 0;
}

// ---- restore ----------------------------------------------------------------

function cmdRestore(args, env) {
  const bridgeHome = defaultBridgeHome(env);
  const result = restoreCodexConfig({ env, backupPath: args["from-backup"] || args.backup || "" });

  if (args.logout === true) {
    codexLogout();
    removeStoredKey(bridgeHome);
    out("Restored your previous Codex config and removed the API-key login plus stored DeepSeek key. Restart Codex.");
    return 0;
  }
  if (!result.changed) {
    out("No bridge config found. Nothing to restore.");
    return 0;
  }
  out("Restored your previous Codex config. Restart Codex to apply.");
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
    const result = spawnSync("npm", ["install", "-g", `codex-deepseek-bridge@${latest}`], { stdio: "inherit" });
    if (result.status !== 0) {
      err("npm upgrade failed. Run: npm install -g codex-deepseek-bridge@latest");
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
  const reconcile = configureCodex({
    env,
    apiKey: "",
    host: config.host,
    port,
    vision: config.enableVision,
    installMethod: method,
    bridgeVersion: latest,
    adaptLogin: false,
  });
  restartBridge(config, reconcile.port, env);

  if (reconcile.catalogChanged) {
    out(`Upgraded to ${latest}. Bridge restarted. The model catalog changed — restart Codex to pick it up.`);
  } else {
    out(`Upgraded to ${latest}. Bridge restarted on http://127.0.0.1:${reconcile.port}.`);
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
    out(`Bridge running on http://127.0.0.1:${port} (report at /report).`);
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
      return cmdRestore(args, env);
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
