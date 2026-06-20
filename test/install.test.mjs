import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInspectResult,
  formatRestoreResult,
  inspectCodexInstall,
  installCodexFiles,
  restoreCodexConfig,
} from "../src/install.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dscb-install-test-"));
}

test("profile-first install does not create or mutate global config", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = installCodexFiles({ codexHome, bridgeHome, activate: false, legacyProfile: false });
  const configPath = path.join(codexHome, "config.toml");
  const statePath = path.join(bridgeHome, "install-state.json");

  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(result.profilePath), true);
  assert.equal(fs.existsSync(result.catalogPath), true);
  assert.equal(fs.existsSync(statePath), true);

  const info = inspectCodexInstall({ codexHome, bridgeHome });
  assert.equal(info.profileExists, true);
  assert.equal(info.managedBlockPresent, false);
  assert.equal(info.catalog.modelCount, 4);
  assert.match(formatInspectResult(info), /Profile mode keeps existing ChatGPT\/OpenAI login state/);
});

test("activation writes a backup and restore returns the original config", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  const originalConfig = 'model = "gpt-5.5"\nmodel_provider = "openai"\n';
  fs.writeFileSync(path.join(codexHome, "config.toml"), originalConfig);

  const result = installCodexFiles({ codexHome, bridgeHome, activate: true });
  const activatedConfig = fs.readFileSync(result.configPath, "utf8");
  assert.match(activatedConfig, /# >>> codex-deepseek-bridge/);
  assert.match(activatedConfig, /model_catalog_json/);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), originalConfig);

  const restore = restoreCodexConfig({ codexHome, bridgeHome });
  assert.equal(restore.changed, true);
  assert.equal(restore.restoredFromBackup, true);
  assert.equal(fs.readFileSync(result.configPath, "utf8"), originalConfig);
  assert.match(formatRestoreResult(restore), /Restored from backup/);
});

test("app login mode writes Codex auth-backed provider config", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = installCodexFiles({ codexHome, bridgeHome, activate: true, codexAuth: true });
  const profile = fs.readFileSync(result.profilePath, "utf8");
  const config = fs.readFileSync(result.configPath, "utf8");
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "install-state.json"), "utf8"));

  assert.match(profile, /requires_openai_auth = true/);
  assert.match(config, /requires_openai_auth = true/);
  assert.match(config, /Codex API-key login is used for this provider/);
  assert.equal(state.codexAuth, true);
  assert.match(state.authBehavior, /Codex API-key auth is used/);
});

test("activation plus legacy profile does not duplicate provider tables", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = installCodexFiles({ codexHome, bridgeHome, activate: true, legacyProfile: true, codexAuth: true });
  const config = fs.readFileSync(result.configPath, "utf8");
  const providerTables = config.match(/\[model_providers\.deepseek_bridge\]/g) || [];

  assert.equal(providerTables.length, 1);
  assert.match(config, /\[profiles\.deepseek\]/);
  assert.match(config, /requires_openai_auth = true/);
});

test("restore removes managed block when no recorded backup exists", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-5.5"\n\n# >>> codex-deepseek-bridge\nmodel = "deepseek-v4-pro"\n# <<< codex-deepseek-bridge\n');

  const restore = restoreCodexConfig({ codexHome, bridgeHome: path.join(root, "bridge") });

  assert.equal(restore.changed, true);
  assert.equal(restore.restoredFromBackup, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), 'model = "gpt-5.5"\n');
});
