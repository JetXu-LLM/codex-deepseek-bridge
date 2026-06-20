import fs from "node:fs";
import path from "node:path";
import { buildCodexManagedConfigBlock, buildCodexProfile, buildModelCatalog } from "./catalog.mjs";
import { defaultBridgeHome, defaultCodexHome } from "./config.mjs";
import { DEFAULT_CODEX_MODEL, DEFAULT_UPSTREAM_MODEL } from "./models.mjs";

const BLOCK_START = "# >>> codex-deepseek-bridge";
const BLOCK_END = "# <<< codex-deepseek-bridge";
const INSTALL_STATE_FILE = "install-state.json";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceManagedBlock(text, block) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${text.slice(0, start).trimEnd()}\n\n${block}${text.slice(end + BLOCK_END.length).trimStart()}`;
  }
  return `${text.trimEnd()}\n\n${block}`;
}

function removeManagedBlock(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return text;
  }
  const next = end + BLOCK_END.length;
  return `${text.slice(0, start).trimEnd()}\n\n${text.slice(next).trimStart()}`.trim();
}

function hasManagedBlock(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  return start !== -1 && end !== -1 && end > start;
}

function shouldWriteConfig({ activate, legacyProfile }) {
  return activate || legacyProfile;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function installStatePath(bridgeHome) {
  return path.join(bridgeHome, INSTALL_STATE_FILE);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readCatalogSummary(catalogPath) {
  const catalog = readJson(catalogPath);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    exists: Boolean(catalog),
    modelCount: models.length,
    modelIds: models.map((model) => model.slug || model.id).filter(Boolean),
  };
}

export function installCodexFiles({
  env = process.env,
  codexHome = defaultCodexHome(env),
  bridgeHome = defaultBridgeHome(env),
  alias = DEFAULT_CODEX_MODEL,
  upstreamModel = DEFAULT_UPSTREAM_MODEL,
  host = "127.0.0.1",
  port = 8787,
  profileName = "deepseek",
  activate = false,
  legacyProfile = false,
  codexAuth = false,
  vision = false,
} = {}) {
  ensureDir(codexHome);
  ensureDir(bridgeHome);

  const catalogPath = path.join(bridgeHome, "models.json");
  const profilePath = path.join(codexHome, `${profileName}.config.toml`);
  const configPath = path.join(codexHome, "config.toml");
  const baseUrl = `http://${host}:${port}/v1`;

  writeJson(
    catalogPath,
    buildModelCatalog({
      alias,
      upstreamModel,
      displayName: `${upstreamModel} via Codex DeepSeek Bridge`,
      vision,
    }),
  );
  fs.writeFileSync(profilePath, buildCodexProfile({ alias, baseUrl, catalogPath, codexAuth }));

  let backupPath = "";
  if (shouldWriteConfig({ activate, legacyProfile })) {
    const block = buildCodexManagedConfigBlock({ alias, baseUrl, catalogPath, profileName, activate, legacyProfile, codexAuth });
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    if (existing) {
      backupPath = `${configPath}.${timestamp()}.bak`;
      fs.writeFileSync(backupPath, existing);
    }
    fs.writeFileSync(configPath, replaceManagedBlock(existing, block));
  }

  const result = {
    codexHome,
    bridgeHome,
    catalogPath,
    profilePath,
    configPath,
    backupPath,
    baseUrl,
    profileName,
    activated: activate,
    legacyProfile,
    codexAuth,
  };
  writeJson(installStatePath(bridgeHome), {
    ...result,
    installedAt: new Date().toISOString(),
    modelCatalogBehavior: "Codex model_catalog_json is an override in current verified Codex builds; profile mode scopes it to --profile.",
    authBehavior: codexAuth
      ? "Codex API-key auth is used for the local DeepSeek provider. The stored key is sent as bearer auth to the configured local bridge while App Login Mode is active."
      : "The bridge does not use Codex login credentials in profile mode.",
  });
  return result;
}

export function formatInstallResult(result) {
  const lines = [
    "Codex DeepSeek Bridge files installed.",
    `Catalog: ${result.catalogPath}`,
    `Profile: ${result.profilePath}`,
    `Bridge URL: ${result.baseUrl}`,
    `CLI profile: codex --profile ${result.profileName}`,
  ];
  if (result.activated || result.legacyProfile) {
    lines.push(`Global config updated: ${result.configPath}`);
    if (result.backupPath) {
      lines.push(`Backup: ${result.backupPath}`);
    }
    if (result.activated) {
      lines.push("App DeepSeek mode is active. In current Codex builds, model_catalog_json may replace the visible model catalog until restored.");
      if (result.codexAuth) {
        lines.push("App Login Mode is active. Codex API-key auth will be sent to the local bridge provider.");
        lines.push("Use a DeepSeek API key for this Codex API-key login, then run `codex-deepseek-bridge restore --logout` when leaving App Login Mode.");
      }
    }
    if (result.legacyProfile && !result.activated) {
      lines.push("Only a legacy named profile was added; your default Codex model/provider was not changed.");
    }
  } else {
    lines.push("Global config was not changed. Use --activate to make this the default Codex provider.");
  }
  return `${lines.join("\n")}\n`;
}

export function inspectCodexInstall({
  env = process.env,
  codexHome = defaultCodexHome(env),
  bridgeHome = defaultBridgeHome(env),
  profileName = "deepseek",
} = {}) {
  const configPath = path.join(codexHome, "config.toml");
  const profilePath = path.join(codexHome, `${profileName}.config.toml`);
  const statePath = installStatePath(bridgeHome);
  const state = readJson(statePath);
  const catalogPath = state?.catalogPath || path.join(bridgeHome, "models.json");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  return {
    codexHome,
    bridgeHome,
    configPath,
    profilePath,
    statePath,
    catalogPath,
    configExists: fs.existsSync(configPath),
    profileExists: fs.existsSync(profilePath),
    managedBlockPresent: hasManagedBlock(configText),
    authFileExists: fs.existsSync(path.join(codexHome, "auth.json")),
    state,
    catalog: readCatalogSummary(catalogPath),
  };
}

export function formatInspectResult(info) {
  const lines = [
    "Codex DeepSeek Bridge install diagnostics.",
    `Codex home: ${info.codexHome}`,
    `Bridge home: ${info.bridgeHome}`,
    `Profile: ${info.profileExists ? "present" : "missing"} (${info.profilePath})`,
    `Global managed block: ${info.managedBlockPresent ? "present" : "not present"}`,
    `Auth file: ${info.authFileExists ? "present" : "not present"} (OS keychain/keyring auth may still exist)`,
    `Catalog: ${info.catalog.exists ? `${info.catalog.modelCount} models` : "missing"} (${info.catalogPath})`,
  ];
  if (info.catalog.modelIds.length) {
    lines.push(`Catalog models: ${info.catalog.modelIds.join(", ")}`);
  }
  if (info.state?.backupPath) {
    lines.push(`Last backup: ${info.state.backupPath}`);
  }
  if (info.state?.codexAuth) {
    lines.push("App Login Mode: enabled. Codex API-key auth is expected to be sent to the local bridge provider.");
  }
  lines.push("Profile mode keeps existing ChatGPT/OpenAI login state. App DeepSeek mode changes the active local provider until restored.");
  lines.push("For users without a ChatGPT/OpenAI account, App Login Mode can use a DeepSeek API key stored by Codex API-key auth while the provider points at localhost.");
  lines.push("For users with ChatGPT login, prefer Profile Mode unless you intentionally want to switch this Codex home into DeepSeek-only app routing.");
  return `${lines.join("\n")}\n`;
}

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

  if (backupPath) {
    if (!fs.existsSync(backupPath)) {
      return { configPath, changed: false, reason: `Backup not found: ${backupPath}` };
    }
    fs.writeFileSync(preRestoreBackupPath, existing);
    fs.writeFileSync(configPath, fs.readFileSync(backupPath, "utf8"));
    return { configPath, changed: true, backupPath, preRestoreBackupPath, restoredFromBackup: true };
  }

  const state = readJson(installStatePath(bridgeHome));
  if (state?.backupPath && fs.existsSync(state.backupPath)) {
    fs.writeFileSync(preRestoreBackupPath, existing);
    fs.writeFileSync(configPath, fs.readFileSync(state.backupPath, "utf8"));
    return {
      configPath,
      changed: true,
      backupPath: state.backupPath,
      preRestoreBackupPath,
      restoredFromBackup: true,
    };
  }

  if (!hasManagedBlock(existing)) {
    return { configPath, changed: false, reason: "No codex-deepseek-bridge managed block found." };
  }

  fs.writeFileSync(preRestoreBackupPath, existing);
  const restored = removeManagedBlock(existing);
  fs.writeFileSync(configPath, restored ? `${restored}\n` : "");
  return { configPath, changed: true, preRestoreBackupPath, restoredFromBackup: false };
}

export function formatRestoreResult(result) {
  if (!result.changed) {
    return `${result.reason}\nConfig: ${result.configPath}\n`;
  }
  const lines = [`Restored Codex config: ${result.configPath}`, `Pre-restore backup: ${result.preRestoreBackupPath}`];
  if (result.restoredFromBackup) {
    lines.push(`Restored from backup: ${result.backupPath}`);
  } else {
    lines.push("Removed the codex-deepseek-bridge managed block.");
  }
  lines.push("If you used App Login Mode with a DeepSeek key stored in Codex auth, run `codex logout` or `codex-deepseek-bridge restore --logout` to remove it.");
  lines.push("Restart Codex app for app-mode changes to take effect.");
  return `${lines.join("\n")}\n`;
}
