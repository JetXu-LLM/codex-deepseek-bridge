import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_SCHEMA_VERSION,
  adaptCodexLogin,
  configureCodex,
  detectLoginMode,
  restoreCodexConfig,
  selectBridgeProviderStrategy,
} from "../src/install.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dscb-install-test-"));
}

// Fake `codex` runner that records calls and reports "not logged in" by default.
function makeRunCodex(calls, statusOutput = "Not logged in") {
  return (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[0] === "login" && args[1] === "status") {
      return { ok: false, status: 1, stdout: statusOutput, stderr: "" };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
}

test("configureCodex writes one managed block and the two-model catalog", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = configureCodex({
    codexHome,
    bridgeHome,
    apiKey: "deepseek-test-key",
    port: 8787,
    bridgeVersion: "1.2.3",
    installMethod: "npm",
    runCodex: makeRunCodex([]),
  });

  const config = fs.readFileSync(result.configPath, "utf8");
  assert.equal((config.match(/# >>> codex-deepseek-bridge/g) || []).length, 1);
  assert.match(config, /^model = "deepseek-pro"$/m);
  assert.match(config, /^model_provider = "deepseek_bridge"$/m);
  assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(config, /\[model_providers\.deepseek_bridge\]/);
  assert.match(config, /^supports_websockets = false$/m);
  assert.match(config, /^requires_openai_auth = false$/m);
  // No legacy named-profile file is created.
  assert.equal(fs.existsSync(path.join(codexHome, "deepseek.config.toml")), false);

  const catalog = JSON.parse(fs.readFileSync(result.catalogPath, "utf8"));
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["deepseek-pro", "deepseek-flash"]);

  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "install-state.json"), "utf8"));
  assert.equal(state.stateSchemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.installMethod, "npm");
  assert.equal(state.bridgeVersion, "1.2.3");
  assert.equal(state.port, 8787);
  assert.equal(state.loginMode, "none");
  assert.equal(state.providerId, "deepseek_bridge");
  assert.equal(state.providerMode, "custom");
  assert.equal(state.historyPreserved, false);
});

test("stores the DeepSeek key owner-only and never changes Codex login", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  const calls = [];

  configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-secret", runCodex: makeRunCodex(calls) });

  const keyFile = path.join(bridgeHome, "deepseek-key");
  assert.equal(fs.existsSync(keyFile), true);
  assert.equal(fs.readFileSync(keyFile, "utf8").trim(), "deepseek-secret");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }
  assert.equal(calls.some((call) => call.args[0] === "logout"), false);
  assert.equal(calls.some((call) => call.args[0] === "login" && call.args[1] === "--with-api-key"), false);
});

test("backs up an existing config and restore returns the original", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  const original = 'model = "gpt-5.5"\nmodel_provider = "openai"\n\n[model_providers.openai]\nname = "openai"\n';
  fs.writeFileSync(path.join(codexHome, "config.toml"), original);

  const result = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-x", runCodex: makeRunCodex([]) });
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);

  const written = fs.readFileSync(result.configPath, "utf8");
  assert.doesNotMatch(written, /^model = "gpt-5.5"$/m);
  assert.doesNotMatch(written, /^\[model_providers\.openai\]$/m);

  const restore = restoreCodexConfig({ codexHome, bridgeHome });
  assert.equal(restore.changed, true);
  assert.equal(restore.restoredFromBackup, true);
  assert.equal(fs.readFileSync(result.configPath, "utf8"), original);
});

test("restore removes config.toml when setup created it on a zero-config machine", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-x", runCodex: makeRunCodex([]) });
  assert.equal(fs.existsSync(result.configPath), true);
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "install-state.json"), "utf8"));
  assert.equal(state.configExistedBeforeSetup, false);
  assert.equal(state.backupPath, "");

  const restore = restoreCodexConfig({ codexHome, bridgeHome });
  assert.equal(restore.changed, true);
  assert.equal(restore.removedConfig, true);
  assert.equal(fs.existsSync(result.configPath), false);
});

test("re-running setup migrates legacy zero-config state so restore removes config.toml", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const first = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-x", runCodex: makeRunCodex([]) });
  const legacyStatePath = path.join(bridgeHome, "install-state.json");
  const legacyState = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  delete legacyState.configExistedBeforeSetup;
  fs.writeFileSync(legacyStatePath, `${JSON.stringify(legacyState, null, 2)}\n`);

  configureCodex({ codexHome, bridgeHome, apiKey: "", runCodex: makeRunCodex([]) });
  const state = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  assert.equal(state.configExistedBeforeSetup, false);

  const restore = restoreCodexConfig({ codexHome, bridgeHome });
  assert.equal(restore.removedConfig, true);
  assert.equal(fs.existsSync(first.configPath), false);
});

test("restore keeps an originally empty config.toml empty", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, "");

  const result = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-x", runCodex: makeRunCodex([]) });
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "install-state.json"), "utf8"));
  assert.equal(state.configExistedBeforeSetup, true);
  assert.equal(state.backupPath, "");

  const restore = restoreCodexConfig({ codexHome, bridgeHome });
  assert.equal(restore.changed, true);
  assert.equal(restore.removedConfig, undefined);
  assert.equal(fs.existsSync(result.configPath), true);
  assert.equal(fs.readFileSync(result.configPath, "utf8"), "");
});

test("re-running setup is idempotent: one block, key and original backup preserved", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');

  const first = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-one", runCodex: makeRunCodex([]) });
  const second = configureCodex({ codexHome, bridgeHome, apiKey: "", runCodex: makeRunCodex([]) });

  const config = fs.readFileSync(second.configPath, "utf8");
  assert.equal((config.match(/# >>> codex-deepseek-bridge/g) || []).length, 1);
  assert.equal(second.backupPath, first.backupPath);
  assert.equal(fs.readFileSync(path.join(bridgeHome, "deepseek-key"), "utf8").trim(), "deepseek-one");
});

test("re-running setup with Desktop patch active updates the catalog without duplicating config", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const first = configureCodex({
    codexHome,
    bridgeHome,
    apiKey: "deepseek-one",
    includeFlash: false,
    runCodex: makeRunCodex([]),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(first.catalogPath, "utf8")).models.map((entry) => entry.slug), [
    "deepseek-pro",
  ]);

  const second = configureCodex({
    codexHome,
    bridgeHome,
    apiKey: "",
    includeFlash: true,
    runCodex: makeRunCodex([]),
  });

  const config = fs.readFileSync(second.configPath, "utf8");
  assert.equal((config.match(/# >>> codex-deepseek-bridge/g) || []).length, 1);
  assert.equal(second.backupPath, first.backupPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(second.catalogPath, "utf8")).models.map((entry) => entry.slug), [
    "deepseek-pro",
    "deepseek-flash",
  ]);
  assert.equal(fs.readFileSync(path.join(bridgeHome, "deepseek-key"), "utf8").trim(), "deepseek-one");
});

// Returns the TOML table a key's first occurrence belongs to ("" = root).
function tableOf(configText, key) {
  let section = "";
  for (const line of configText.split("\n")) {
    const trimmed = line.trim();
    const table = trimmed.match(/^\[+(.+?)\]+$/);
    if (table) {
      section = table[1];
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (kv && kv[1] === key) {
      return section;
    }
  }
  return null;
}

test("does not reparent user root keys under the managed provider table", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  // Mirrors a real config: many root keys (beyond what the block sets), then tables.
  const original = [
    "#:schema https://example.test/schema.json",
    'model = "gpt-5.5"',
    "model_context_window = 400000",
    'model_reasoning_effort = "xhigh"',
    "disable_response_storage = true",
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'model_provider = "codex"',
    'notify = ["a", "turn-ended"]',
    "",
    "[model_providers.codex]",
    'name = "codex"',
    "",
    '[projects."/Users/me/proj"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), original);

  const result = configureCodex({ codexHome, bridgeHome, apiKey: "deepseek-x", adaptLogin: false, runCodex: makeRunCodex([]) });
  const config = fs.readFileSync(result.configPath, "utf8");

  // The managed values win at root.
  assert.equal(tableOf(config, "model"), "");
  assert.match(config, /^model = "deepseek-pro"$/m);
  assert.doesNotMatch(config, /^model = "gpt-5.5"$/m);
  // model_reasoning_effort appears exactly once (no duplicate-key TOML error).
  assert.equal((config.match(/^model_reasoning_effort = /gm) || []).length, 1);
  assert.match(config, /^model_reasoning_effort = "xhigh"$/m);

  // CRITICAL: the user's other root keys stay at ROOT, not under the provider table.
  for (const key of ["disable_response_storage", "sandbox_mode", "approval_policy", "notify", "model_context_window"]) {
    assert.equal(tableOf(config, key), "", `${key} must remain a root key`);
  }

  // The managed provider table replaces the user's codex table while active;
  // restore brings the backed-up original file back.
  assert.equal((config.match(/^\[model_providers\.codex\]$/gm) || []).length, 1);
  assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:8787\/v1"$/m);
  assert.doesNotMatch(config, /^name = "codex"$/m);
  assert.match(config, /^\[projects\."\/Users\/me\/proj"\]$/m);

  // Every root key must appear before the first table header (valid TOML ordering).
  const firstTableLine = config.split("\n").findIndex((line) => /^\s*\[/.test(line));
  const sandboxLine = config.split("\n").findIndex((line) => line.startsWith("sandbox_mode"));
  assert.ok(sandboxLine !== -1 && sandboxLine < firstTableLine, "root keys must precede the first table");
});

test("uses an independent provider for the reserved OpenAI provider", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    'model_provider = "openai"\nopenai_base_url = "https://proxy.example/v1"\n\n[model_providers.openai]\nname = "openai"\n',
  );

  const result = configureCodex({
    codexHome,
    bridgeHome,
    apiKey: "deepseek-x",
    adaptLogin: false,
    runCodex: makeRunCodex([]),
    historyProviderCounts: [{ provider: "openai", count: 12 }],
  });
  const config = fs.readFileSync(result.configPath, "utf8");

  assert.match(config, /^model_provider = "deepseek_bridge"$/m);
  assert.match(config, /^\[model_providers\.deepseek_bridge\]$/m);
  assert.match(config, /^supports_websockets = false$/m);
  assert.doesNotMatch(config, /^openai_base_url = /m);
  assert.doesNotMatch(config, /^\[model_providers\.openai\]$/m);
  assert.equal(result.providerMode, "custom");
  assert.equal(result.providerSource, "reserved-openai");
  assert.equal(result.historyPreserved, false);
});

test("falls back to an independent provider for reserved non-OpenAI providers", () => {
  const strategy = selectBridgeProviderStrategy({
    configText: 'model_provider = "ollama"\n',
    historyProviderCounts: [{ provider: "ollama", count: 20 }],
  });

  assert.equal(strategy.provider, "deepseek_bridge");
  assert.equal(strategy.providerMode, "custom");
  assert.equal(strategy.historyPreserved, false);
});

test("uses dominant non-reserved history when the config provider is reserved", () => {
  const strategy = selectBridgeProviderStrategy({
    configText: 'model_provider = "openai"\n',
    historyProviderCounts: [
      { provider: "codex", count: 935 },
      { provider: "openai", count: 3 },
    ],
  });

  assert.equal(strategy.provider, "codex");
  assert.equal(strategy.providerMode, "custom");
  assert.equal(strategy.providerSource, "history");
  assert.equal(strategy.historyPreserved, true);
});

test("restore strips the managed block when there is no recorded backup", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-5.5"\n\n# >>> codex-deepseek-bridge\nmodel = "deepseek-pro"\n# <<< codex-deepseek-bridge\n');

  const restore = restoreCodexConfig({ codexHome, bridgeHome: path.join(root, "bridge") });
  assert.equal(restore.changed, true);
  assert.equal(restore.restoredFromBackup, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), 'model = "gpt-5.5"\n');
});

test("detectLoginMode reads codex login status output", () => {
  assert.equal(
    detectLoginMode({ runCodex: () => ({ ok: true, status: 0, stdout: "Logged in using ChatGPT", stderr: "" }) }),
    "chatgpt",
  );
  assert.equal(
    detectLoginMode({ runCodex: () => ({ ok: true, status: 0, stdout: "Logged in using an API key", stderr: "" }) }),
    "api-key",
  );
  assert.equal(
    detectLoginMode({ runCodex: () => ({ ok: false, status: 1, stdout: "Not logged in", stderr: "" }) }),
    "none",
  );
});

test("detectLoginMode falls back to auth.json, then to uncertain", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const missing = () => ({ ok: false, status: -1, stdout: "", stderr: "", missing: true });

  assert.equal(detectLoginMode({ codexHome, runCodex: missing }), "uncertain");

  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  assert.equal(detectLoginMode({ codexHome, runCodex: missing }), "chatgpt");

  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "value" }));
  assert.equal(detectLoginMode({ codexHome, runCodex: missing }), "api-key");
});

test("adaptCodexLogin leaves a ChatGPT login untouched", () => {
  const calls = [];
  const runCodex = (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[1] === "status") {
      return { ok: true, status: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };

  const result = adaptCodexLogin({ apiKey: "deepseek-x", runCodex });
  assert.equal(result.loginMode, "chatgpt");
  assert.equal(result.action, "unchanged");
  assert.equal(calls.some((call) => call.args[0] === "login" && call.args[1] === "--with-api-key"), false);
  assert.equal(calls.some((call) => call.args[0] === "logout"), false);
});
