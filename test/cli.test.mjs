import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "codex-deepseek-bridge.mjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dscb-cli-test-"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function entryFor(content) {
  const hash = sha256(content);
  return {
    size: content.length,
    offset: "0",
    integrity: {
      algorithm: "SHA256",
      hash,
      blockSize: 4194304,
      blocks: [hash],
    },
  };
}

function writeFakeAsar(file, source) {
  const content = Buffer.from(source, "utf8");
  const header = {
    files: {
      webview: {
        files: {
          assets: {
            files: {
              "model-list-filter-test.js": entryFor(content),
            },
          },
        },
      },
    },
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBytes.length + 8, 4);
  prefix.writeUInt32LE(headerBytes.length + 4, 8);
  prefix.writeUInt32LE(headerBytes.length, 12);
  fs.writeFileSync(file, Buffer.concat([prefix, headerBytes, content]));
}

test("setup --print-prompt prints the canonical prompt", () => {
  const result = spawnSync(process.execPath, [bin, "setup", "--print-prompt"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek\./);
  assert.match(result.stdout, /deepseek-pro by default/);
  assert.match(result.stdout, /put it in your replies, never commit it\./);
});

test("setup --from-stdin --no-start writes the managed block, catalog, and key", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "deepseek-cli-key\n",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_DESKTOP_PATCH: "off",
      DSCB_UPDATE_CHECK: "off",
      // Keep `codex` off PATH so login detection stays read-only in the test.
      PATH: "",
    },
  });

  assert.equal(result.status, 0);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /# >>> codex-deepseek-bridge/);
  assert.match(config, /^model = "deepseek-pro"$/m);
  assert.match(config, /^model_provider = "deepseek_bridge"$/m);

  const catalog = JSON.parse(fs.readFileSync(path.join(bridgeHome, "models.json"), "utf8"));
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["deepseek-pro"]);

  const keyFile = path.join(bridgeHome, "deepseek-key");
  assert.equal(fs.readFileSync(keyFile, "utf8").trim(), "deepseek-cli-key");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }

  // The key must never be echoed to stdout/stderr.
  assert.doesNotMatch(result.stdout, /deepseek-cli-key/);
  assert.doesNotMatch(result.stderr || "", /deepseek-cli-key/);
});

test("doctor reports offline diagnostics and the local report URL", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    DSCB_HOME: bridgeHome,
    DSCB_DESKTOP_PATCH: "off",
    DSCB_UPDATE_CHECK: "off",
    PATH: "",
  };

  const setup = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "deepseek-cli-key\n",
    env,
  });
  assert.equal(setup.status, 0);

  const result = spawnSync(process.execPath, [bin, "doctor"], { encoding: "utf8", env });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Bridge: offline\. Start it with: codex-deepseek-bridge start/);
  assert.match(result.stdout, /DeepSeek key: stored\. Codex config: DeepSeek active\./);
  assert.match(result.stdout, /Desktop compatibility patch: disabled\./);
  assert.match(result.stdout, /Report: http:\/\/localhost:8787\/report \(available after the bridge starts\)\./);
  assert.doesNotMatch(result.stdout, /deepseek-cli-key/);
  assert.doesNotMatch(result.stderr || "", /deepseek-cli-key/);
});

test("plain setup does not patch a patchable Desktop ASAR", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  const appAsar = path.join(root, "Codex.app", "Contents", "Resources", "app.asar");
  const source =
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}";
  fs.mkdirSync(path.dirname(appAsar), { recursive: true });
  writeFakeAsar(appAsar, source);
  const before = fs.readFileSync(appAsar);

  const result = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "deepseek-cli-key\n",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_CODEX_APP_ASAR: appAsar,
      DSCB_UPDATE_CHECK: "off",
      PATH: "",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /not applied\./);
  assert.deepEqual(fs.readFileSync(appAsar), before);

  const catalog = JSON.parse(fs.readFileSync(path.join(bridgeHome, "models.json"), "utf8"));
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["deepseek-pro"]);
});

test("setup with no key gives guidance and makes no changes", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const result = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_DESKTOP_PATCH: "off",
      DSCB_UPDATE_CHECK: "off",
      DEEPSEEK_API_KEY: "",
      PATH: "",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /No DeepSeek API key was provided\./);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
});

test("setup rejects malformed key input without writing config or echoing it", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  const badKey = "sk-test bad";

  const result = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: `${badKey}\n`,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_DESKTOP_PATCH: "off",
      DSCB_UPDATE_CHECK: "off",
      DEEPSEEK_API_KEY: "",
      PATH: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /That does not look like a DeepSeek API key\./);
  assert.doesNotMatch(result.stdout, /sk-test bad/);
  assert.doesNotMatch(result.stderr || "", /sk-test bad/);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
  assert.equal(fs.existsSync(path.join(bridgeHome, "deepseek-key")), false);
});

test("setup reuses an existing stored key after a normal restore", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  fs.mkdirSync(bridgeHome, { recursive: true });
  fs.writeFileSync(path.join(bridgeHome, "deepseek-key"), "deepseek-existing-key\n", { mode: 0o600 });

  const result = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_DESKTOP_PATCH: "off",
      DSCB_UPDATE_CHECK: "off",
      DEEPSEEK_API_KEY: "",
      PATH: "",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Using the DeepSeek key already stored on this machine\./);
  assert.doesNotMatch(result.stdout, /deepseek-existing-key/);
  assert.doesNotMatch(result.stderr || "", /deepseek-existing-key/);
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /^model = "deepseek-pro"$/m);
  assert.equal(fs.readFileSync(path.join(bridgeHome, "deepseek-key"), "utf8").trim(), "deepseek-existing-key");
});

test("restore returns a zero-config machine to no config.toml", () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");

  const setup = spawnSync(process.execPath, [bin, "setup", "--from-stdin", "--no-start"], {
    encoding: "utf8",
    input: "deepseek-cli-key\n",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_DESKTOP_PATCH: "off",
      DSCB_UPDATE_CHECK: "off",
      PATH: "",
    },
  });
  assert.equal(setup.status, 0);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), true);

  const restore = spawnSync(process.execPath, [bin, "restore"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      DSCB_UPDATE_CHECK: "off",
      PATH: "",
    },
  });

  assert.equal(restore.status, 0);
  assert.match(restore.stdout, /original no-config state restored/);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
});
