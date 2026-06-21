import os from "node:os";
import path from "node:path";
import { DEFAULT_CODEX_MODEL, resolveUpstreamModels } from "./models.mjs";
import { isEnabled } from "./util.mjs";

export const DEFAULT_MODEL_ALIAS = DEFAULT_CODEX_MODEL;
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_BRIDGE_DIR_NAME = "codex-deepseek-bridge";
export const STORED_KEY_FILE = "deepseek-key";

export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function defaultBridgeHome(env = process.env) {
  return env.DSCB_HOME || path.join(defaultCodexHome(env), DEFAULT_BRIDGE_DIR_NAME);
}

export function storedKeyPath(env = process.env) {
  return path.join(defaultBridgeHome(env), STORED_KEY_FILE);
}

function disabledPath(value) {
  return value === "" || value === "0" || value === "false" || value === "off" || value === "none" || value === "disabled";
}

export function defaultLogDir(env = process.env) {
  return path.join(defaultBridgeHome(env), "logs");
}

export function resolveLogDir(env = process.env, override) {
  if (override !== undefined) {
    return disabledPath(override) ? "" : override;
  }
  if (env.DSCB_LOG_DIR !== undefined) {
    return disabledPath(env.DSCB_LOG_DIR) ? "" : env.DSCB_LOG_DIR;
  }
  return defaultLogDir(env);
}

export function buildRuntimeConfig(env = process.env, overrides = {}) {
  const logDir = resolveLogDir(env, overrides.logDir);
  const upstreamModels = overrides.upstreamModels ?? resolveUpstreamModels(env);
  return {
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? env.PORT ?? 8787),
    deepseekBaseUrl: overrides.deepseekBaseUrl ?? env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
    upstreamModels,
    includeFlash: overrides.includeFlash ?? optionalBooleanEnv(env.DSCB_INCLUDE_FLASH, true),
    upstreamModel: overrides.upstreamModel ?? upstreamModels[DEFAULT_CODEX_MODEL],
    modelAlias: overrides.modelAlias ?? DEFAULT_MODEL_ALIAS,
    enableVision: overrides.enableVision ?? isEnabled(env.DEEPSEEK_ENABLE_VISION || "0"),
    apiKey: overrides.apiKey ?? env.DEEPSEEK_API_KEY ?? "",
    storedKeyPath: overrides.storedKeyPath ?? storedKeyPath(env),
    bridgeApiKey: overrides.bridgeApiKey ?? env.DSCB_BRIDGE_API_KEY ?? "",
    quiet: overrides.quiet ?? isEnabled(env.QUIET || "0"),
    logDir,
    logPayloads: overrides.logPayloads ?? isEnabled(env.DSCB_LOG_PAYLOADS || "0"),
    pidFile: overrides.pidFile ?? env.DSCB_PID_FILE ?? path.join(defaultBridgeHome(env), "bridge.pid"),
    stdoutLog: overrides.stdoutLog ?? env.DSCB_STDOUT_LOG ?? path.join(defaultBridgeHome(env), "bridge.stdout.log"),
    stderrLog: overrides.stderrLog ?? env.DSCB_STDERR_LOG ?? path.join(defaultBridgeHome(env), "bridge.stderr.log"),
  };
}

function optionalBooleanEnv(value, fallback) {
  if (value == null) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function configFromArgs(args, env = process.env) {
  const optionalBoolean = (value) => {
    if (value == null) {
      return undefined;
    }
    return value === true || value === "true" || value === "1";
  };

  return buildRuntimeConfig(env, {
    host: args.host,
    port: args.port,
    deepseekBaseUrl: args.deepseekBaseUrl || args["deepseek-base-url"],
    enableVision: optionalBoolean(args.vision),
    bridgeApiKey: args.bridgeApiKey || args["bridge-api-key"],
    quiet: optionalBoolean(args.quiet),
    logDir: args.logDir || args["log-dir"],
    logPayloads: optionalBoolean(args.logPayloads ?? args["log-payloads"]),
    pidFile: args.pidFile || args["pid-file"],
    stdoutLog: args.stdoutLog || args["stdout-log"],
    stderrLog: args.stderrLog || args["stderr-log"],
  });
}
