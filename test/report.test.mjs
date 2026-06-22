import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { buildPromptDiagnostics } from "../src/prompt-diagnostics.mjs";
import { buildReportData, reportDataForConfig, reportHtml } from "../src/report.mjs";
import { updateCacheFile } from "../src/update-check.mjs";

test("prompt diagnostics compare prefix continuity without storing prompt text", () => {
  const firstPrompt = buildPromptDiagnostics({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "You are Codex." },
      { role: "user", content: "List files" },
    ],
    tools: [{ type: "function", function: { name: "apply_patch", parameters: {} } }],
  });
  const secondPrompt = buildPromptDiagnostics({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "You are Codex." },
      { role: "user", content: "List files" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Continue" },
    ],
    tools: [{ type: "function", function: { name: "apply_patch", parameters: {} } }],
  });

  const data = buildReportData(
    { logDir: "/tmp/logs", modelAlias: "deepseek-v4-pro", upstreamModel: "deepseek-v4-pro" },
    [
      {
        type: "request.started",
        time: "2026-06-20T00:00:00.000Z",
        requestId: "req_1",
        request: { model: "deepseek-v4-pro" },
        upstream: { model: "deepseek-v4-pro" },
        prompt: firstPrompt,
      },
      {
        type: "request.completed",
        time: "2026-06-20T00:00:01.000Z",
        requestId: "req_1",
        durationMs: 1000,
        response: {
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
            input_tokens_details: {
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 20,
            },
          },
          cache: { hitTokens: 0, missTokens: 20 },
        },
      },
      {
        type: "request.started",
        time: "2026-06-20T00:00:02.000Z",
        requestId: "req_2",
        request: { model: "deepseek-v4-pro" },
        upstream: { model: "deepseek-v4-pro" },
        prompt: secondPrompt,
      },
      {
        type: "request.completed",
        time: "2026-06-20T00:00:03.000Z",
        requestId: "req_2",
        durationMs: 1200,
        response: {
          usage: {
            input_tokens: 40,
            output_tokens: 6,
            total_tokens: 46,
            input_tokens_details: {
              prompt_cache_hit_tokens: 20,
              prompt_cache_miss_tokens: 20,
            },
          },
          cache: { hitTokens: 20, missTokens: 20 },
        },
      },
    ],
  );

  assert.equal(data.summary.totalCalls, 2);
  assert.equal(data.summary.cacheHitRate, 1 / 3);
  assert.equal(data.prefix.comparedCalls, 1);
  assert.equal(data.prefix.lowRisk, 1);
  assert.equal(data.calls[0].prefix.previousPromptCovered, 1);
});

test("report data exposes cached update availability", () => {
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dscb-report-update-test-"));
  fs.writeFileSync(
    updateCacheFile(bridgeHome),
    `${JSON.stringify({ lastCheck: "2026-06-22T00:00:00.000Z", latest: "9.0.0" })}\n`,
  );

  const data = reportDataForConfig(
    {
      bridgeHome,
      logDir: path.join(bridgeHome, "logs"),
      modelAlias: "deepseek-pro",
      upstreamModel: "deepseek-v4-pro",
    },
    { currentVersion: "1.0.0" },
  );

  assert.equal(data.update.updateAvailable, true);
  assert.equal(data.update.latest, "9.0.0");
  assert.match(reportHtml(), /updateNotice/);
});
