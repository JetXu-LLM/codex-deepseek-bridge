import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { configureCodex } from "../src/install.mjs";

const DEFAULT_APP_CLI = "/Applications/Codex.app/Contents/Resources/codex";

function appCliPath() {
  return process.env.CODEX_APP_CLI || DEFAULT_APP_CLI;
}

function fail(message, details = {}) {
  process.stderr.write(`${message}\n`);
  if (Object.keys(details).length > 0) {
    process.stderr.write(`${JSON.stringify(details, null, 2)}\n`);
  }
  process.exit(1);
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function summarize(model) {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    hidden: model.hidden,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort),
    inputModalities: model.inputModalities,
  };
}

async function main() {
  const cli = appCliPath();
  if (!fs.existsSync(cli)) {
    fail(`Codex app CLI not found: ${cli}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dscb-codex-app-server-"));
  const codexHome = path.join(root, "codex");
  const bridgeHome = path.join(root, "bridge");
  configureCodex({
    codexHome,
    bridgeHome,
    apiKey: "fake-deepseek-key",
    adaptLogin: false,
    runCodex: () => ({ ok: false, status: -1, stdout: "", stderr: "", missing: true }),
  });

  const child = spawn(cli, ["app-server", "--stdio"], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      DSCB_HOME: bridgeHome,
      RUST_LOG: "off",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });

  let buffer = "";
  let initResponse = null;
  let modelResponse = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === "1") {
        initResponse = message;
      } else if (message.id === "2") {
        modelResponse = message;
      }
    }
  });

  send(child, { id: "1", method: "initialize", params: { clientInfo: { name: "dscb-verify", version: "0" } } });
  setTimeout(() => send(child, { method: "initialized" }), 80);
  setTimeout(
    () => send(child, { id: "2", method: "model/list", params: { cursor: null, limit: 100, includeHidden: true } }),
    160,
  );

  const response = await waitFor(() => modelResponse, 5000);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));

  if (!initResponse?.result?.codexHome) {
    fail("Codex app-server did not initialize.", { initResponse });
  }
  if (!response?.result?.data) {
    fail("Codex app-server did not return model/list data.", { response });
  }

  const models = response.result.data.map(summarize);
  const slugs = models.map((model) => model.model);
  if (slugs.join(",") !== "deepseek-pro,deepseek-flash") {
    fail("Codex app-server returned the wrong model order.", { models });
  }

  const pro = models[0];
  if (
    pro.displayName !== "DeepSeek Pro" ||
    pro.isDefault !== true ||
    pro.defaultReasoningEffort !== "high" ||
    pro.supportedReasoningEfforts?.join(",") !== "none,high,xhigh"
  ) {
    fail("Codex app-server returned an incompatible DeepSeek Pro entry.", { models });
  }

  const flash = models[1];
  if (flash.displayName !== "DeepSeek Flash" || flash.isDefault !== false) {
    fail("Codex app-server returned an incompatible DeepSeek Flash entry.", { models });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, codexHome: initResponse.result.codexHome, models }, null, 2)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
