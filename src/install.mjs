import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BRIDGE_PROVIDER_ID,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  OPENAI_PROVIDER_ID,
  PROVIDER_MODE_CUSTOM,
  buildManagedConfigBlock,
  buildModelCatalog,
} from "./catalog.mjs";
import { defaultBridgeHome, defaultCodexHome } from "./config.mjs";
import { DEFAULT_CODEX_MODEL } from "./models.mjs";
import { deepSeekKeyValidationMessage, validateDeepSeekKey } from "./key.mjs";

const INSTALL_STATE_FILE = "install-state.json";
const STORED_KEY_FILE = "deepseek-key";
export const STATE_SCHEMA_VERSION = 1;

// Root keys setup owns while DeepSeek is active. Re-running setup strips these
// from the user's root region so the managed values win without duplicate-key
// TOML errors or stale provider redirects. Restore brings the original file back.
const MANAGED_ROOT_KEYS = new Set([
  "model",
  "model_provider",
  "model_catalog_json",
  "model_reasoning_effort",
  "openai_base_url",
]);

const RESERVED_PROVIDER_IDS = new Set([
  OPENAI_PROVIDER_ID,
  "ollama",
  "lmstudio",
  "amazon-bedrock",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function installStatePath(bridgeHome) {
  return path.join(bridgeHome, INSTALL_STATE_FILE);
}

function storedKeyFilePath(bridgeHome) {
  return path.join(bridgeHome, STORED_KEY_FILE);
}

// ---- Managed block manipulation ---------------------------------------------

export function hasManagedBlock(text) {
  const start = text.indexOf(MANAGED_BLOCK_START);
  const end = text.indexOf(MANAGED_BLOCK_END);
  return start !== -1 && end !== -1 && end > start;
}

export function removeManagedBlock(text) {
  const start = text.indexOf(MANAGED_BLOCK_START);
  const end = text.indexOf(MANAGED_BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return text;
  }
  const next = end + MANAGED_BLOCK_END.length;
  return `${text.slice(0, start).trimEnd()}\n\n${text.slice(next).trimStart()}`.trim();
}

function removeManagedRootKeys(text) {
  const lines = text.split(/\n/);
  let inRoot = true;
  return lines
    .filter((line) => {
      if (/^\s*\[/.test(line)) {
        inRoot = false;
      }
      if (!inRoot) {
        return true;
      }
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      return !match || !MANAGED_ROOT_KEYS.has(match[1]);
    })
    .join("\n");
}

function removeProviderTable(text, provider) {
  const target = `model_providers.${provider}`;
  const lines = text.split(/\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const table = line.trim().match(/^\[+(.+?)\]+$/);
    if (table) {
      const name = table[1].trim();
      skipping = name === target || name.startsWith(`${target}.`);
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

// Split a config into its root region (bare keys/comments before the first
// table header) and its table region (from the first `[...]` onward).
function splitRootAndTables(text) {
  const lines = text.split(/\n/);
  const tableStart = lines.findIndex((line) => /^\s*\[/.test(line));
  if (tableStart === -1) {
    return { root: text, tables: "" };
  }
  return {
    root: lines.slice(0, tableStart).join("\n"),
    tables: lines.slice(tableStart).join("\n"),
  };
}

// Compose the config so it stays valid TOML: all root keys first (the user's
// remaining root keys, then the managed root keys), then the managed provider
// table, then the user's tables. The managed block must never leave a table
// open ahead of user root keys, or those keys get reparented under it.
function placeManagedBlockFirst(existing, block, { provider = BRIDGE_PROVIDER_ID, extraProviders = [] } = {}) {
  let cleaned = removeManagedRootKeys(removeManagedBlock(existing));
  for (const id of [provider, ...extraProviders]) {
    if (id) {
      cleaned = removeProviderTable(cleaned, id);
    }
  }
  const { root, tables } = splitRootAndTables(cleaned);
  const rootTrimmed = root.trim();
  const tablesTrimmed = tables.trim();
  let out = "";
  if (rootTrimmed) {
    out += `${rootTrimmed}\n\n`;
  }
  out += block;
  if (tablesTrimmed) {
    out += `\n${tablesTrimmed}\n`;
  }
  return out;
}

// ---- Provider selection ------------------------------------------------------

function parseRootStringValue(text, key) {
  const lines = String(text || "").split(/\n/);
  let inRoot = true;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(['"])(.*?)\\1\\s*(?:#.*)?$`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inRoot = false;
    }
    if (!inRoot) {
      return "";
    }
    const match = line.match(pattern);
    if (match) {
      return match[2].trim();
    }
  }
  return "";
}

function providerSelectionConfig(existing, priorState) {
  if (hasManagedBlock(existing) && priorState?.backupPath && fs.existsSync(priorState.backupPath)) {
    try {
      return fs.readFileSync(priorState.backupPath, "utf8");
    } catch {
      return removeManagedBlock(existing);
    }
  }
  return hasManagedBlock(existing) ? removeManagedBlock(existing) : existing;
}

function readHistoryProviderCounts(codexHome) {
  const db = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(db)) {
    return [];
  }
  try {
    const stdout = execFileSync(
      "sqlite3",
      [
        db,
        [
          "select model_provider, count(*)",
          "from threads",
          "where model_provider is not null and model_provider <> ''",
          "group by model_provider",
          "order by count(*) desc",
        ].join(" "),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return stdout
      .trim()
      .split(/\n/)
      .filter(Boolean)
      .map((line) => {
        const [provider, count] = line.split("|");
        return { provider: String(provider || "").trim(), count: Number(count || 0) };
      })
      .filter((entry) => entry.provider && Number.isFinite(entry.count) && entry.count > 0);
  } catch {
    return [];
  }
}

function dominantHistoryProvider(historyProviderCounts = []) {
  return [...historyProviderCounts]
    .filter((entry) => entry?.provider && Number(entry.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count))[0] || null;
}

export function selectBridgeProviderStrategy({
  configText = "",
  historyProviderCounts = [],
} = {}) {
  const configProvider = parseRootStringValue(configText, "model_provider");
  const historyProvider = dominantHistoryProvider(historyProviderCounts);
  const historyProviderId = historyProvider?.provider || "";

  if (configProvider && !RESERVED_PROVIDER_IDS.has(configProvider)) {
    return {
      provider: configProvider,
      providerMode: PROVIDER_MODE_CUSTOM,
      providerSource: "config",
      historyProviderId,
      historyPreserved: true,
    };
  }

  if (historyProviderId && !RESERVED_PROVIDER_IDS.has(historyProviderId)) {
    return {
      provider: historyProviderId,
      providerMode: PROVIDER_MODE_CUSTOM,
      providerSource: "history",
      historyProviderId,
      historyPreserved: true,
    };
  }

  return {
    provider: BRIDGE_PROVIDER_ID,
    providerMode: PROVIDER_MODE_CUSTOM,
    providerSource: configProvider ? `reserved-${configProvider}` : "default",
    historyProviderId,
    historyPreserved: historyProviderId === BRIDGE_PROVIDER_ID,
  };
}

// ---- DeepSeek key storage (secret; never logged) ----------------------------

function readStoredKey(bridgeHome) {
  try {
    return fs.readFileSync(storedKeyFilePath(bridgeHome), "utf8").trim();
  } catch {
    return "";
  }
}

function applyOwnerOnlyAcl(file) {
  if (process.platform !== "win32") {
    return;
  }
  const user = process.env.USERNAME || process.env.USER;
  if (!user) {
    return;
  }
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch {
    // Best-effort owner-only ACL; POSIX mode bits are a no-op on Windows.
  }
}

export function storeDeepSeekKey(bridgeHome, key) {
  const validation = validateDeepSeekKey(key);
  if (!validation.ok) {
    return "";
  }
  ensureDir(bridgeHome);
  const file = storedKeyFilePath(bridgeHome);
  fs.writeFileSync(file, `${validation.key}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on some filesystems; ACL covers Windows.
  }
  applyOwnerOnlyAcl(file);
  return file;
}

export function removeStoredKey(bridgeHome) {
  try {
    fs.unlinkSync(storedKeyFilePath(bridgeHome));
    return true;
  } catch {
    return false;
  }
}

// ---- Codex login detect-and-adapt (doc 02 §2, doc 06 Phase 2) ---------------

function defaultRunCodex(args, { input } = {}) {
  try {
    const stdout = execFileSync("codex", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: false, status: -1, stdout: "", stderr: "codex not found", missing: true };
    }
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

// Parse `codex login status`. Returns a class or null (caller falls back to auth.json).
function classifyLoginStatus(result) {
  if (!result || result.missing) {
    return null;
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (result.ok) {
    if (text.includes("chatgpt")) return "chatgpt";
    if (text.includes("api key") || text.includes("api-key")) return "api-key";
    if (text.includes("not logged in") || text.includes("not signed in")) return "none";
    return null;
  }
  if (text.includes("not logged in") || text.includes("not signed in")) return "none";
  return null;
}

// auth.json fallback (Codex's own resolution order). Absent file => uncertain
// (it may live in the OS keyring), never assume "none".
function classifyAuthJson(codexHome) {
  const auth = readJson(path.join(codexHome, "auth.json"));
  if (!auth || typeof auth !== "object") {
    return "uncertain";
  }
  const mode = typeof auth.auth_mode === "string" ? auth.auth_mode.toLowerCase() : "";
  if (mode.includes("chatgpt")) return "chatgpt";
  if (mode.includes("api")) return "api-key";
  if (auth.personal_access_token || auth.chatgpt_auth_tokens || auth.chatgpt) return "chatgpt";
  if (auth.bedrock_api_key) return "api-key";
  if (auth.OPENAI_API_KEY || auth.openai_api_key) return "api-key";
  return "chatgpt";
}

export function detectLoginMode({
  env = process.env,
  codexHome = defaultCodexHome(env),
  runCodex = defaultRunCodex,
} = {}) {
  const fromStatus = classifyLoginStatus(runCodex(["login", "status"]));
  if (fromStatus) {
    return fromStatus;
  }
  return classifyAuthJson(codexHome);
}

// `restore --logout` is the explicit, user-invoked way to remove the API-key
// credential that setup created. This is never called implicitly by setup.
export function codexLogout({ runCodex = defaultRunCodex } = {}) {
  return runCodex(["logout"]);
}

export function codexVersion({ runCodex = defaultRunCodex } = {}) {
  const result = runCodex(["--version"]);
  if (!result || !result.ok) {
    return null;
  }
  const text = String(result.stdout || "").trim();
  const match = text.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : text || null;
}

// Detect login state without replacing it. The bridge uses its stored DeepSeek
// key directly, so Codex auth can remain ChatGPT, API-key, none, or uncertain.
export function adaptCodexLogin({
  env = process.env,
  codexHome = defaultCodexHome(env),
  runCodex = defaultRunCodex,
} = {}) {
  const loginMode = detectLoginMode({ env, codexHome, runCodex });
  return { loginMode, action: "unchanged" };
}

// ---- Setup / idempotent reconcile (doc 04 setup, doc 09 §6) -----------------

export function configureCodex({
  env = process.env,
  codexHome = defaultCodexHome(env),
  bridgeHome = defaultBridgeHome(env),
  apiKey = "",
  model = DEFAULT_CODEX_MODEL,
  host = "127.0.0.1",
  port = 8787,
  reasoningEffort = "xhigh",
  vision = false,
  includeFlash = true,
  installMethod = "source",
  bridgeVersion = "0.0.0",
  runCodex = defaultRunCodex,
  adaptLogin = true,
  historyProviderCounts,
} = {}) {
  ensureDir(codexHome);
  ensureDir(bridgeHome);

  const catalogPath = path.join(bridgeHome, "models.json");
  const configPath = path.join(codexHome, "config.toml");
  const baseUrl = `http://${host}:${port}/v1`;
  const keyValidation = String(apiKey || "").trim() ? validateDeepSeekKey(apiKey) : { ok: true, key: "" };
  if (!keyValidation.ok) {
    throw new Error(deepSeekKeyValidationMessage(keyValidation));
  }

  // Catalog is regenerated from code every reconcile (single source of truth).
  const previousCatalog = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : "";
  const catalog = buildModelCatalog({ vision, includeFlash });
  writeJson(catalogPath, catalog);
  const catalogChanged = previousCatalog !== fs.readFileSync(catalogPath, "utf8");

  // Back up the user's original config once; preserve that backup across re-runs.
  const configExistsBeforeCurrentRun = fs.existsSync(configPath);
  const existing = configExistsBeforeCurrentRun ? fs.readFileSync(configPath, "utf8") : "";
  const priorState = readJson(installStatePath(bridgeHome));
  const originalConfigExisted =
    hasManagedBlock(existing) && typeof priorState?.configExistedBeforeSetup === "boolean"
      ? priorState.configExistedBeforeSetup
      : hasManagedBlock(existing) && !priorState?.backupPath
        ? Boolean(removeManagedBlock(existing).trim())
        : configExistsBeforeCurrentRun;
  let backupPath = priorState?.backupPath || "";
  if (existing && !hasManagedBlock(existing)) {
    backupPath = `${configPath}.${timestamp()}.bak`;
    fs.writeFileSync(backupPath, existing);
  }
  const providerStrategy = selectBridgeProviderStrategy({
    configText: providerSelectionConfig(existing, priorState),
    historyProviderCounts: historyProviderCounts || readHistoryProviderCounts(codexHome),
  });
  const block = buildManagedConfigBlock({
    model,
    provider: providerStrategy.provider,
    baseUrl,
    catalogPath,
    reasoningEffort,
  });
  const replacedProvider = providerStrategy.providerMode === PROVIDER_MODE_CUSTOM ? providerStrategy.provider : "";
  fs.writeFileSync(configPath, placeManagedBlockFirst(existing, block, { provider: replacedProvider, extraProviders: [OPENAI_PROVIDER_ID] }));

  // Store the key only when supplied; otherwise keep any existing stored key.
  let keyStored = Boolean(readStoredKey(bridgeHome));
  if (String(apiKey || "").trim()) {
    storeDeepSeekKey(bridgeHome, apiKey);
    keyStored = true;
  }

  // Detect login state for reporting only. Setup must not replace Codex auth.
  let login;
  if (adaptLogin) {
    login = adaptCodexLogin({ env, codexHome, bridgeHome, apiKey, runCodex });
  } else {
    login = { loginMode: detectLoginMode({ env, codexHome, runCodex }), action: "skipped" };
  }

  writeJson(installStatePath(bridgeHome), {
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    bridgeVersion,
    previousVersion: priorState?.bridgeVersion ?? null,
    installMethod,
    port,
    loginMode: login.loginMode,
    backupPath,
    catalogPath,
    configPath,
    configExistedBeforeSetup: originalConfigExisted,
    providerId: providerStrategy.provider,
    providerMode: providerStrategy.providerMode,
    providerSource: providerStrategy.providerSource,
    historyProviderId: providerStrategy.historyProviderId,
    historyPreserved: providerStrategy.historyPreserved,
    catalogModelIds: catalog.models.map((entry) => entry.slug || entry.id).filter(Boolean),
    installedAt: new Date().toISOString(),
  });

  return {
    codexHome,
    bridgeHome,
    catalogPath,
    configPath,
    backupPath,
    baseUrl,
    model,
    port,
    providerId: providerStrategy.provider,
    providerMode: providerStrategy.providerMode,
    providerSource: providerStrategy.providerSource,
    historyProviderId: providerStrategy.historyProviderId,
    historyPreserved: providerStrategy.historyPreserved,
    catalogModelIds: catalog.models.map((entry) => entry.slug || entry.id).filter(Boolean),
    keyStored,
    loginMode: login.loginMode,
    loginAction: login.action,
    catalogChanged,
  };
}

// ---- Inspect (doctor / status) ----------------------------------------------

export function inspectCodexInstall({
  env = process.env,
  codexHome = defaultCodexHome(env),
  bridgeHome = defaultBridgeHome(env),
} = {}) {
  const configPath = path.join(codexHome, "config.toml");
  const statePath = installStatePath(bridgeHome);
  const state = readJson(statePath);
  const catalogPath = state?.catalogPath || path.join(bridgeHome, "models.json");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const catalog = readJson(catalogPath);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    codexHome,
    bridgeHome,
    configPath,
    statePath,
    catalogPath,
    configExists: fs.existsSync(configPath),
    managedBlockPresent: hasManagedBlock(configText),
    keyStored: Boolean(readStoredKey(bridgeHome)),
    authFileExists: fs.existsSync(path.join(codexHome, "auth.json")),
    state,
    catalog: {
      exists: Boolean(catalog),
      modelCount: models.length,
      modelIds: models.map((entry) => entry.slug || entry.id).filter(Boolean),
    },
  };
}

// ---- Restore (reversibility core) -------------------------------------------

export function restoreCodexConfig({
  env = process.env,
  codexHome = defaultCodexHome(env),
  bridgeHome = defaultBridgeHome(env),
  backupPath = "",
} = {}) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return { configPath, changed: false, reason: "No config.toml found." };
  }

  const existing = fs.readFileSync(configPath, "utf8");
  const preRestoreBackupPath = `${configPath}.${timestamp()}.pre-restore.bak`;
  const state = readJson(installStatePath(bridgeHome));
  const recordedBackup = backupPath || state?.backupPath || "";

  if (recordedBackup) {
    if (!fs.existsSync(recordedBackup)) {
      return { configPath, changed: false, reason: `Backup not found: ${recordedBackup}` };
    }
    fs.writeFileSync(preRestoreBackupPath, existing);
    fs.writeFileSync(configPath, fs.readFileSync(recordedBackup, "utf8"));
    return { configPath, changed: true, backupPath: recordedBackup, preRestoreBackupPath, restoredFromBackup: true };
  }

  if (!hasManagedBlock(existing)) {
    return { configPath, changed: false, reason: "No bridge config found." };
  }

  fs.writeFileSync(preRestoreBackupPath, existing);
  const restored = removeManagedBlock(existing);
  if (restored) {
    fs.writeFileSync(configPath, `${restored}\n`);
    return { configPath, changed: true, preRestoreBackupPath, restoredFromBackup: false };
  }
  if (state?.configExistedBeforeSetup !== true) {
    fs.rmSync(configPath, { force: true });
    return { configPath, changed: true, preRestoreBackupPath, restoredFromBackup: false, removedConfig: true };
  }
  fs.writeFileSync(configPath, "");
  return { configPath, changed: true, preRestoreBackupPath, restoredFromBackup: false };
}

export function readInstallState(bridgeHome = defaultBridgeHome()) {
  return readJson(installStatePath(bridgeHome));
}
