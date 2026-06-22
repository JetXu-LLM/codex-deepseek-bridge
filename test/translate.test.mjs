import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeConfig, configFromArgs } from "../src/config.mjs";
import {
  buildChatMessages,
  buildDeepSeekRequest,
  buildToolRegistry,
  convertDeepSeekMessageToItems,
  mapDeepSeekThinking,
  normalizeReasoningEffort,
  responseOutputText,
  usageFromDeepSeek,
} from "../src/translate.mjs";
import { buildModelCatalog } from "../src/catalog.mjs";
import { resolveModelRequest } from "../src/models.mjs";

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

test("uses safe upstream names but returns Codex namespace calls as leaf names", () => {
  const registry = buildToolRegistry([
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [{ type: "function", name: "js", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "mcp__computer_use",
      tools: [{ type: "function", name: "list_apps", parameters: { type: "object", properties: {} } }],
    },
  ]);

  assert.deepEqual(
    registry.chatTools.map((tool) => tool.function.name),
    ["mcp__node_repl__js", "mcp__computer_use__list_apps"],
  );

  const items = convertDeepSeekMessageToItems(
    {
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "mcp__node_repl__js", arguments: "{\"code\":\"1+1\"}" } },
      ],
    },
    registry,
  );
  assert.equal(items[1].type, "function_call");
  assert.equal(items[1].name, "js");
});

test("repairs uniquely mangled namespace tool names returned by DeepSeek", () => {
  const registry = buildToolRegistry([
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [{ type: "function", name: "js", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "mcp__computer_use",
      tools: [{ type: "function", name: "list_apps", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "mcp__openaiDeveloperDocs",
      tools: [{ type: "function", name: "list_openai_docs", parameters: { type: "object", properties: {} } }],
    },
  ]);

  const items = convertDeepSeekMessageToItems(
    {
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "mcp__node_repljs", arguments: "{\"code\":\"1+1\"}" } },
        { id: "call_2", type: "function", function: { name: "mcp__computer_uselist_apps", arguments: "{}" } },
        { id: "call_3", type: "function", function: { name: "mcp__openaiDeveloperDocslist_openai_docs", arguments: "{}" } },
        { id: "call_4", type: "function", function: { name: "list_apps", arguments: "{}" } },
        { id: "call_5", type: "function", function: { name: "computer_use_list_apps", arguments: "{}" } },
        { id: "call_6", type: "function", function: { name: "mcp__computer_use__list_app", arguments: "{}" } },
      ],
    },
    registry,
  );

  assert.equal(items[1].name, "js");
  assert.equal(items[2].name, "list_apps");
  assert.equal(items[3].name, "list_openai_docs");
  assert.equal(items[4].name, "list_apps");
  assert.equal(items[5].name, "list_apps");
  assert.equal(items[6].name, "list_apps");
});

test("does not repair ambiguous or too-short namespace tool names", () => {
  const registry = buildToolRegistry([
    {
      type: "namespace",
      name: "mcp__alpha",
      tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "mcp__beta",
      tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "mcp__computer_use",
      tools: [{ type: "function", name: "list_apps", parameters: { type: "object", properties: {} } }],
    },
  ]);

  const items = convertDeepSeekMessageToItems(
    {
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "mcp__computer_use", arguments: "{}" } },
      ],
    },
    registry,
  );

  assert.equal(items[1].name, "search");
  assert.equal(items[2].name, "mcp__computer_use");
});

test("builds DeepSeek request from Responses input and tools", () => {
  const request = {
    model: "deepseek-pro",
    instructions: "You are Codex.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List files" }] }],
    tools: [{ type: "function", name: "list_files", parameters: { type: "object", properties: {} } }],
    stream: true,
    reasoning: { effort: "xhigh" },
  };
  const config = buildRuntimeConfig({});
  const registry = buildToolRegistry(request.tools);
  const body = buildDeepSeekRequest(request, registry, config);

  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "List files");
  assert.equal(body.tools[0].function.name, "list_files");
});

test("routes the two Codex slugs and maps the three reasoning efforts", () => {
  const registry = buildToolRegistry([]);
  const config = buildRuntimeConfig({});

  const flash = buildDeepSeekRequest({ model: "deepseek-flash", input: "fast" }, registry, config);
  assert.equal(flash.model, "deepseek-v4-flash");
  assert.deepEqual(flash.thinking, { type: "enabled" });
  assert.equal(flash.reasoning_effort, "high");

  const none = buildDeepSeekRequest({ model: "deepseek-pro", input: "fast", reasoning: { effort: "none" } }, registry, config);
  assert.deepEqual(none.thinking, { type: "disabled" });
  assert.equal(none.reasoning_effort, undefined);

  const xhigh = buildDeepSeekRequest({ model: "deepseek-pro", input: "deep", reasoning: { effort: "xhigh" } }, registry, config);
  assert.deepEqual(xhigh.thinking, { type: "enabled" });
  assert.equal(xhigh.reasoning_effort, "max");
});

test("maps Codex reasoning effort to DeepSeek thinking controls", () => {
  assert.deepEqual(mapDeepSeekThinking({ effort: "none" }), { thinking: { type: "disabled" } });
  assert.deepEqual(mapDeepSeekThinking({ effort: "minimal" }), { thinking: { type: "disabled" } });
  assert.deepEqual(mapDeepSeekThinking({ effort: "low" }), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(mapDeepSeekThinking({ effort: "medium" }), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(mapDeepSeekThinking({ effort: "high" }), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(mapDeepSeekThinking({ effort: "xhigh" }), { thinking: { type: "enabled" }, reasoning_effort: "max" });
  assert.deepEqual(mapDeepSeekThinking({ effort: "max" }), { thinking: { type: "enabled" }, reasoning_effort: "max" });
  // Default (no effort) is high.
  assert.deepEqual(mapDeepSeekThinking({}), { thinking: { type: "enabled" }, reasoning_effort: "high" });
});

test("normalizeReasoningEffort folds to none/high/xhigh", () => {
  assert.equal(normalizeReasoningEffort("none"), "none");
  assert.equal(normalizeReasoningEffort("minimal"), "none");
  assert.equal(normalizeReasoningEffort("low"), "high");
  assert.equal(normalizeReasoningEffort("medium"), "high");
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort(undefined), "high");
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("max"), "xhigh");
});

test("resolveModelRequest folds legacy slugs to the two known slugs", () => {
  const config = buildRuntimeConfig({});
  assert.deepEqual(resolveModelRequest("deepseek-pro", config), {
    codexModel: "deepseek-pro",
    slug: "deepseek-pro",
    upstreamModel: "deepseek-v4-pro",
  });
  assert.equal(resolveModelRequest("deepseek-v4-flash", config).slug, "deepseek-flash");
  assert.equal(resolveModelRequest("deepseek-v4-flash", config).upstreamModel, "deepseek-v4-flash");
  assert.equal(resolveModelRequest("deepseek-codex", config).slug, "deepseek-pro");
  assert.equal(resolveModelRequest(undefined, config).slug, "deepseek-pro");
});

test("model catalog exposes exactly two slugs and three reasoning efforts", () => {
  const catalog = buildModelCatalog();
  const slugs = catalog.models.map((model) => model.slug);
  assert.deepEqual(slugs, ["deepseek-pro", "deepseek-flash"]);
  assert.deepEqual(catalog.models.map((model) => model.model), ["deepseek-pro", "deepseek-flash"]);
  assert.equal(catalog.models[0].display_name, "DeepSeek Pro");
  assert.equal(catalog.models[0].displayName, "DeepSeek Pro");
  assert.equal(catalog.models[1].display_name, "DeepSeek Flash");
  assert.equal(catalog.models[0].default_reasoning_level, "xhigh");
  assert.equal(catalog.models[0].defaultReasoningEffort, "xhigh");
  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((entry) => entry.effort),
    ["none", "high", "xhigh"],
  );
  assert.deepEqual(
    catalog.models[0].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ["none", "high", "xhigh"],
  );
  assert.equal("default_reasoning_effort" in catalog.models[0], false);
  assert.equal("supported_reasoning_efforts" in catalog.models[0], false);
  assert.deepEqual(catalog.models[0].input_modalities, ["text"]);
  assert.deepEqual(catalog.models[0].inputModalities, ["text"]);
  assert.equal(catalog.models[0].isDefault, true);
  assert.equal(catalog.models[1].isDefault, false);
  assert.equal(catalog.models[0].priority, 1);
  assert.equal(catalog.models[1].priority, 2);
  assert.equal(catalog.models[0].hidden, false);
});

test("runtime config maps upstream models from env and keeps vision flag", () => {
  const config = configFromArgs({}, { DEEPSEEK_ENABLE_VISION: "1", DEEPSEEK_MODEL_PRO: "deepseek-v5-pro" });
  assert.equal(config.enableVision, true);
  assert.equal(config.modelAlias, "deepseek-pro");
  assert.equal(config.upstreamModels["deepseek-pro"], "deepseek-v5-pro");
  assert.equal(config.upstreamModels["deepseek-flash"], "deepseek-v4-flash");
  assert.equal(config.upstreamModel, "deepseek-v5-pro");
});

test("payload logging is on by default and can be disabled", () => {
  assert.equal(configFromArgs({}, {}).logPayloads, true);
  assert.equal(configFromArgs({}, { DSCB_LOG_PAYLOADS: "0" }).logPayloads, false);
  assert.equal(configFromArgs({ "no-log-payloads": true }, {}).logPayloads, false);
  assert.equal(configFromArgs({ "log-payloads": true }, { DSCB_LOG_PAYLOADS: "0" }).logPayloads, true);
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

test("restores namespace leaf tool calls to their safe upstream names", () => {
  const registry = buildToolRegistry([
    {
      type: "namespace",
      name: "mcp__computer_use",
      tools: [{ type: "function", name: "list_apps", parameters: { type: "object", properties: {} } }],
    },
  ]);
  const messages = buildChatMessages(
    {
      input: [
        { type: "function_call", call_id: "call_1", name: "list_apps", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "Calculator" },
      ],
    },
    registry,
    { enableVision: false },
  );

  assert.equal(messages[0].tool_calls[0].function.name, "mcp__computer_use__list_apps");
  assert.equal(messages[1].tool_call_id, "call_1");
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
