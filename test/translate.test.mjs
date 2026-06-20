import test from "node:test";
import assert from "node:assert/strict";
import { configFromArgs } from "../src/config.mjs";
import {
  buildDeepSeekRequest,
  buildToolRegistry,
  buildChatMessages,
  convertDeepSeekMessageToItems,
  mapDeepSeekThinking,
  responseOutputText,
  usageFromDeepSeek,
} from "../src/translate.mjs";
import { buildCodexLegacyProfile, buildModelCatalog } from "../src/catalog.mjs";

test("wraps Codex custom freeform tools as function tools", () => {
  const registry = buildToolRegistry([
    {
      type: "custom",
      name: "apply_patch",
      description: "Apply a patch",
      format: { definition: "start: patch" },
    },
  ]);

  assert.equal(registry.chatTools.length, 1);
  assert.equal(registry.chatTools[0].function.name, "apply_patch");
  assert.deepEqual(registry.chatTools[0].function.parameters.required, ["input"]);
});

test("builds DeepSeek request from Responses input and tools", () => {
  const request = {
    model: "deepseek-v4-pro",
    instructions: "You are Codex.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List files" }] }],
    tools: [{ type: "function", name: "list_files", parameters: { type: "object", properties: {} } }],
    stream: true,
    reasoning: { effort: "xhigh" },
  };
  const config = {
    modelAlias: "deepseek-v4-pro",
    upstreamModel: "deepseek-v4-pro",
    thinking: "enabled",
    enableVision: false,
  };
  const registry = buildToolRegistry(request.tools);
  const body = buildDeepSeekRequest(request, registry, config);

  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "List files");
  assert.equal(body.tools[0].function.name, "list_files");
});

test("routes Pro, Flash, and no-thinking model variants", () => {
  const registry = buildToolRegistry([]);
  const config = {
    modelAlias: "deepseek-v4-pro",
    upstreamModel: "deepseek-v4-pro",
    thinking: "enabled",
    enableVision: false,
  };

  const flash = buildDeepSeekRequest({ model: "deepseek-v4-flash", input: "fast" }, registry, config);
  assert.equal(flash.model, "deepseek-v4-flash");
  assert.deepEqual(flash.thinking, { type: "enabled" });
  assert.equal(flash.reasoning_effort, "high");

  const noThinking = buildDeepSeekRequest({ model: "deepseek-v4-pro-no-thinking", input: "fast" }, registry, config);
  assert.equal(noThinking.model, "deepseek-v4-pro");
  assert.deepEqual(noThinking.thinking, { type: "disabled" });
  assert.equal(noThinking.reasoning_effort, undefined);
});

test("maps Codex thinking effort to DeepSeek controls", () => {
  assert.deepEqual(mapDeepSeekThinking({ effort: "none" }), { thinking: { type: "disabled" } });
  assert.deepEqual(mapDeepSeekThinking({ effort: "medium" }), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(mapDeepSeekThinking({ effort: "xhigh" }), { thinking: { type: "enabled" }, reasoning_effort: "max" });
  assert.deepEqual(mapDeepSeekThinking({ configuredThinking: "none", effort: "xhigh" }), { thinking: { type: "disabled" } });
});

test("model catalog exposes Pro, Flash, and no-thinking variants", () => {
  const catalog = buildModelCatalog();
  const slugs = catalog.models.map((model) => model.slug);
  assert.deepEqual(slugs.slice(0, 4), [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-pro-no-thinking",
    "deepseek-v4-flash-no-thinking",
  ]);
  assert.equal(catalog.models[0].displayName, "DeepSeek V4 Pro");
});

test("runtime config keeps env vision flag when CLI flag is absent", () => {
  const config = configFromArgs({}, { DEEPSEEK_ENABLE_VISION: "1", DEEPSEEK_MODEL: "deepseek-v4-flash" });
  assert.equal(config.enableVision, true);
  assert.equal(config.modelAlias, "deepseek-v4-flash");
});

test("converts DeepSeek tool calls back to Responses output items", () => {
  const registry = buildToolRegistry([{ type: "custom", name: "apply_patch", description: "Patch" }]);
  const items = convertDeepSeekMessageToItems(
    {
      reasoning_content: "Need a patch",
      content: "I will patch it.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) },
        },
      ],
    },
    registry,
  );

  assert.equal(items[0].type, "reasoning");
  assert.equal(items[1].type, "message");
  assert.equal(items[2].type, "custom_tool_call");
  assert.equal(items[2].input, "*** Begin Patch\n*** End Patch");
  assert.equal(responseOutputText(items), "I will patch it.");
});

test("restores prior tool calls and reasoning from Responses input", () => {
  const registry = buildToolRegistry([{ type: "function", name: "run", parameters: { type: "object", properties: {} } }]);
  const messages = buildChatMessages(
    {
      input: [
        { type: "function_call", call_id: "call_1", name: "run", arguments: "{\"cmd\":\"date\"}" },
        { type: "function_call_output", call_id: "call_1", output: "Sat Jun 20" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    },
    registry,
    { enableVision: false },
  );

  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].tool_calls[0].function.name, "run");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[2].role, "user");
});

test("maps DeepSeek cache usage fields", () => {
  const usage = usageFromDeepSeek({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
  });

  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.input_tokens_details.cached_tokens, 80);
  assert.equal(usage.input_tokens_details.prompt_cache_hit_tokens, 80);
  assert.equal(usage.input_tokens_details.prompt_cache_miss_tokens, 20);
});

test("legacy Codex profile keeps provider at top level", () => {
  const profile = buildCodexLegacyProfile({
    alias: "deepseek-v4-pro",
    baseUrl: "http://127.0.0.1:8787/v1",
    catalogPath: "/tmp/models.json",
    profileName: "deepseek",
  });

  assert.match(profile, /\[model_providers\.deepseek_bridge\]/);
  assert.match(profile, /\[profiles\.deepseek\]/);
  assert.doesNotMatch(profile, /\[profiles\.deepseek\.model_providers/);
});
