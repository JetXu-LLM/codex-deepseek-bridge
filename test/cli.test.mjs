import test from "node:test";
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

test("setup --print-prompt prints the canonical prompt", () => {
  const result = spawnSync(process.execPath, [bin, "setup", "--print-prompt"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek\./);
  assert.match(result.stdout, /models deepseek-pro, deepseek-flash/);
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
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["deepseek-pro", "deepseek-flash"]);

  const keyFile = path.join(bridgeHome, "deepseek-key");
  assert.equal(fs.readFileSync(keyFile, "utf8").trim(), "deepseek-cli-key");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }

  // The key must never be echoed to stdout/stderr.
  assert.doesNotMatch(result.stdout, /deepseek-cli-key/);
  assert.doesNotMatch(result.stderr || "", /deepseek-cli-key/);
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
      DSCB_UPDATE_CHECK: "off",
      DEEPSEEK_API_KEY: "",
      PATH: "",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /No DeepSeek API key was provided\./);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
});
