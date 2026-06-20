import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptDiagnostics } from "../src/prompt-diagnostics.mjs";
import { buildReportData } from "../src/report.mjs";

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
