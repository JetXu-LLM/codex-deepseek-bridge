#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { configFromArgs, parseArgs } from "../src/config.mjs";
import { spawnDaemon, stopDaemon, readPid, isRunning } from "../src/daemon.mjs";
import {
  formatInspectResult,
  formatInstallResult,
  formatRestoreResult,
  inspectCodexInstall,
  installCodexFiles,
  restoreCodexConfig,
} from "../src/install.mjs";
import { startServer } from "../src/server.mjs";
import { buildCacheReport, defaultLogFile, formatCacheReport, loadJsonl } from "../src/cache-report.mjs";

function printHelp() {
  process.stdout.write(`codex-deepseek-bridge

Usage:
  codex-deepseek-bridge app-login [--model deepseek-v4-pro] [--from-stdin] [--no-start]
  codex-deepseek-bridge setup [--model deepseek-v4-pro] [--start] [--activate]
  codex-deepseek-bridge install [--model deepseek-v4-pro] [--activate] [--profile deepseek] [--legacy-profile]
  codex-deepseek-bridge serve [--host 127.0.0.1] [--port 8787] [--daemon]
  codex-deepseek-bridge stop
  codex-deepseek-bridge status
  codex-deepseek-bridge doctor [--live] [--auth]
  codex-deepseek-bridge restore [--from-backup /path/to/config.toml.TIMESTAMP.bak] [--logout]
  codex-deepseek-bridge cache-report [--log-dir ~/.codex/codex-deepseek-bridge/logs]
  codex-deepseek-bridge open-report

Common environment:
  DEEPSEEK_API_KEY          DeepSeek API key used by the bridge
  DEEPSEEK_MODEL            Upstream DeepSeek model, default deepseek-v4-pro
  DEEPSEEK_THINKING         enabled, disabled, or none; default enabled
  DEEPSEEK_ENABLE_VISION    Set 1 when DeepSeek multimodal input is available
  DSCB_LOG_DIR              Directory for calls.jsonl
  DSCB_LOG_PAYLOADS         Set 1 to log redacted request/response payloads

Examples:
  codex-deepseek-bridge app-login
  printenv DEEPSEEK_API_KEY | codex-deepseek-bridge app-login --from-stdin
  codex-deepseek-bridge setup --start
  codex-deepseek-bridge install
  codex-deepseek-bridge install --model deepseek-v4-flash
  codex-deepseek-bridge restore
  DEEPSEEK_API_KEY=... codex-deepseek-bridge serve
  codex --profile deepseek
`);
}

function cacheReport(config, args) {
  const file = args.file || args["log-file"] || defaultLogFile(config);
  if (!file) {
    process.stderr.write("No log file configured. Set DSCB_LOG_DIR or pass --log-file /path/to/calls.jsonl.\n");
    return 1;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`Log file not found: ${file}\n`);
    return 1;
  }
  const report = buildCacheReport(loadJsonl(file));
  process.stdout.write(formatCacheReport(report, file));
  return 0;
}

function parseCodexVersion(output) {
  const match = String(output).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isBefore0134(version) {
  if (!version) {
    return false;
  }
  if (version.major !== 0) {
    return false;
  }
  return version.minor < 134;
}

function runInstall(config, args) {
  const selectedModel = args["default-model"] || args.model || args.alias || args["model-alias"] || config.modelAlias;
  return installCodexFiles({
    alias: selectedModel,
    upstreamModel: config.upstreamModel,
    host: config.host,
    port: config.port,
    profileName: args.profile || "deepseek",
    activate: args.activate === true,
    legacyProfile: detectLegacyProfileNeeded(args),
    codexAuth: args["codex-auth"] === true,
    vision: config.enableVision,
  });
}

function detectLegacyProfileNeeded(args) {
  if (args["legacy-profile"] === true || args.compat === true) {
    return true;
  }
  if (args["no-legacy-profile"] === true) {
    return false;
  }
  try {
    return isBefore0134(parseCodexVersion(execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
  } catch {
    return false;
  }
}

function codexVersionText() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "not found on PATH";
  }
}

function printAuthDiagnostics(args) {
  const info = inspectCodexInstall({ profileName: args.profile || "deepseek" });
  process.stdout.write(formatInspectResult(info));
  process.stdout.write(`Codex CLI: ${codexVersionText()}\n`);
  process.stdout.write("DeepSeek key in this process: ");
  process.stdout.write(process.env.DEEPSEEK_API_KEY ? "available\n" : "not found\n");
  process.stdout.write("Note: Profile Mode uses DEEPSEEK_API_KEY in the bridge process. App Login Mode uses Codex API-key auth to store a DeepSeek key and sends it only to the configured localhost bridge while App Login Mode is active.\n");
  process.stdout.write("If you leave App Login Mode, run `codex-deepseek-bridge restore --logout` so Codex does not keep a DeepSeek key in its API-key login cache.\n");
}

async function doctor(config, args) {
  if (args.auth === true || args._.includes("auth")) {
    printAuthDiagnostics(args);
    return 0;
  }

  const healthUrl = `http://${config.host}:${config.port}/health`;
  let healthOk = false;
  try {
    const response = await fetch(healthUrl);
    healthOk = response.ok;
    process.stdout.write(`Bridge health: ${response.ok ? "ok" : `failed ${response.status}`}\n`);
  } catch (error) {
    process.stdout.write(`Bridge health: offline (${error instanceof Error ? error.message : String(error)})\n`);
  }

  if (!args.live) {
    process.stdout.write(`DeepSeek key: ${config.apiKey ? "available in this process" : "not found in this process"}\n`);
    process.stdout.write(`Logs: ${config.logDir || "disabled"}\n`);
    return healthOk ? 0 : 1;
  }

  if (!healthOk) {
    process.stderr.write("Live test needs the bridge running.\n");
    return 1;
  }
  const response = await fetch(`http://${config.host}:${config.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.modelAlias,
      input: "Reply with exactly: bridge-ok",
      stream: false,
      reasoning: { effort: "high" },
    }),
  });
  const text = await response.text();
  process.stdout.write(`Live response status: ${response.status}\n`);
  if (!response.ok) {
    process.stdout.write(`${text.slice(0, 1000)}\n`);
    return 1;
  }
  const json = JSON.parse(text);
  process.stdout.write(`Live output: ${json.output_text || "(empty)"}\n`);
  return 0;
}

function openReport(config) {
  const url = `http://${config.host}:${config.port}/report`;
  const commands =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [["xdg-open", [url]]];
  try {
    const [command, commandArgs] = commands[0];
    const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
    child.unref();
    process.stdout.write(`Opened ${url}\n`);
  } catch {
    process.stdout.write(`${url}\n`);
  }
  return 0;
}

function startDaemon(config, argv) {
  const existingPid = readPid(config.pidFile);
  if (isRunning(existingPid)) {
    process.stdout.write(`Codex DeepSeek Bridge already running pid ${existingPid}\n`);
    return 0;
  }
  const result = spawnDaemon({
    pidFile: config.pidFile,
    stdoutLog: config.stdoutLog,
    stderrLog: config.stderrLog,
    argv: [process.argv[1], "serve", ...argv.filter((token) => token !== "--daemon")],
  });
  process.stdout.write(`Started Codex DeepSeek Bridge pid ${result.pid}\nPID file: ${result.pidFile}\n`);
  process.stdout.write(`Logs: ${result.stdoutLog}\n      ${result.stderrLog}\n`);
  return 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value.trim()));
    process.stdin.on("error", reject);
  });
}

function codexLoginWithApiKey(apiKey, args = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return { loggedIn: false, reason: "No API key provided." };
  }
  const loginArgs = ["login", "--with-api-key"];
  const authStore = args["auth-store"];
  if (authStore) {
    loginArgs.push("-c", `cli_auth_credentials_store="${authStore}"`);
  }
  execFileSync("codex", loginArgs, {
    input: `${key}\n`,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });
  return { loggedIn: true };
}

function codexLogout(args = {}) {
  const logoutArgs = ["logout"];
  const authStore = args["auth-store"];
  if (authStore) {
    logoutArgs.push("-c", `cli_auth_credentials_store="${authStore}"`);
  }
  execFileSync("codex", logoutArgs, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "help";
  const args = parseArgs(argv.slice(1));
  const config = configFromArgs(args);

  if (command === "help" || args.help || args.h) {
    printHelp();
    return 0;
  }

  if (command === "install") {
    const result = runInstall(config, args);
    process.stdout.write(formatInstallResult(result));
    return 0;
  }

  if (command === "app-login") {
    const appArgs = { ...args, activate: true, "codex-auth": true };
    const result = runInstall(config, appArgs);
    process.stdout.write(formatInstallResult(result));

    const key = args["from-stdin"] === true ? await readStdin() : process.env.DEEPSEEK_API_KEY || "";
    if (key) {
      codexLoginWithApiKey(key, args);
      process.stdout.write("Codex API-key login configured with the provided DeepSeek key. The key was not printed or stored by the bridge.\n");
    } else {
      process.stdout.write("No DEEPSEEK_API_KEY was provided to this command.\n");
      process.stdout.write("Open Codex app, choose API-key login, and paste your DeepSeek API key while App Login Mode points Codex at this local bridge.\n");
      process.stdout.write("If Codex is already signed in with ChatGPT, use Profile Mode instead or rerun `app-login --from-stdin` with your DeepSeek key to intentionally switch this Codex home to App Login Mode.\n");
    }

    if (args["no-start"] !== true) {
      startDaemon(config, []);
    }
    process.stdout.write("Open or restart Codex app after App Login Mode setup. To undo it, run `codex-deepseek-bridge restore --logout` and restart Codex.\n");
    return 0;
  }

  if (command === "setup") {
    const result = runInstall(config, args);
    process.stdout.write(formatInstallResult(result));
    if (args.start === true) {
      if (!config.apiKey) {
        process.stdout.write("Bridge was not started because DEEPSEEK_API_KEY is not available in this process.\n");
        return 1;
      }
      return startDaemon(config, []);
    }
    process.stdout.write("Next: start the bridge with `codex-deepseek-bridge serve --daemon`, then run `codex-deepseek-bridge doctor --live`.\n");
    return 0;
  }

  if (command === "serve") {
    if (args.daemon === true && !process.env.DSCB_DAEMON_CHILD) {
      return startDaemon(config, argv.slice(1));
    }
    fs.mkdirSync(path.dirname(config.pidFile), { recursive: true });
    fs.writeFileSync(config.pidFile, `${process.pid}\n`);
    const server = await startServer(config);
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

  if (command === "stop") {
    const result = stopDaemon(config.pidFile);
    process.stdout.write(result.stopped ? `Stopped pid ${result.pid}\n` : `${result.reason}\n`);
    return result.stopped || result.reason === "Process was already stopped." ? 0 : 1;
  }

  if (command === "status") {
    const pid = readPid(config.pidFile);
    const running = isRunning(pid);
    process.stdout.write(running ? `running pid ${pid}\n` : "not running\n");
    process.stdout.write(`Report: http://${config.host}:${config.port}/report\n`);
    process.stdout.write(`Logs: ${config.logDir || "disabled"}\n`);
    return running ? 0 : 1;
  }

  if (command === "doctor") {
    return doctor(config, args);
  }

  if (command === "restore") {
    const result = restoreCodexConfig({ backupPath: args["from-backup"] || args.backup || "" });
    process.stdout.write(formatRestoreResult(result));
    if (args.logout === true) {
      codexLogout(args);
      process.stdout.write("Codex logout completed. Any Codex-stored API key/access token for this CODEX_HOME was removed.\n");
    }
    return result.changed || args.logout === true || result.reason?.startsWith("No codex-deepseek-bridge") ? 0 : 1;
  }

  if (command === "open-report") {
    return openReport(config);
  }

  if (command === "cache-report") {
    return cacheReport(config, args);
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
