import test from "node:test";
import assert from "node:assert/strict";
import { buildCacheReport, formatCacheReport } from "../src/cache-report.mjs";

test("builds DeepSeek cache report from JSONL events", () => {
  const report = buildCacheReport([
    {
      type: "request.started",
      requestId: "req_1",
      request: { model: "deepseek-v4-pro" },
    },
    {
      type: "request.completed",
      requestId: "req_1",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: {
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        },
        cache: {
          hitTokens: 80,
          missTokens: 20,
        },
      },
    },
    {
      type: "request.started",
      requestId: "req_2",
      request: { model: "deepseek-v4-flash" },
    },
    {
      type: "request.completed",
      requestId: "req_2",
      response: {
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          total_tokens: 60,
          input_tokens_details: {
            prompt_cache_hit_tokens: 10,
            prompt_cache_miss_tokens: 40,
          },
        },
      },
    },
  ]);

  assert.equal(report.completedRequests, 2);
  assert.equal(report.overall.cacheHitTokens, 90);
  assert.equal(report.overall.cacheMissTokens, 60);
  assert.equal(report.overall.cacheHitRate, 0.6);
  assert.equal(report.byModel[0].model, "deepseek-v4-pro");

  const text = formatCacheReport(report, "/tmp/calls.jsonl");
  assert.match(text, /Cache report for \/tmp\/calls\.jsonl/);
  assert.match(text, /deepseek-v4-pro/);
  assert.match(text, /60\.0%/);
});
