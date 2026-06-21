import crypto from "node:crypto";
import { resolveModelRequest } from "./models.mjs";
import { decodeState, encodeState, makeId, nowSeconds } from "./util.mjs";

function safeString(value) {
  if (value == null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function sanitizeToolName(name, usedNames = new Set()) {
  const base = String(name || "tool")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64) || "tool";
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const suffix = crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 8);
  let next = `${base.slice(0, 55)}_${suffix}`;
  let counter = 2;
  while (usedNames.has(next)) {
    next = `${base.slice(0, 52)}_${suffix}_${counter}`;
    counter += 1;
  }
  usedNames.add(next);
  return next;
}

function namespaceToolName(namespace, name) {
  return `${String(namespace || "").replace(/_+$/, "")}__${String(name || "").replace(/^_+/, "")}`;
}

export function buildToolRegistry(responseTools = []) {
  const usedNames = new Set();
  const originalToSafe = new Map();
  const safeToOriginal = new Map();
  const customNames = new Set();
  const chatTools = [];

  const addTool = (originalName, tool, options = {}) => {
    const safeName = sanitizeToolName(originalName, usedNames);
    originalToSafe.set(originalName, safeName);
    safeToOriginal.set(safeName, originalName);
    if (options.custom) {
      customNames.add(originalName);
    }
    chatTools.push({
      type: "function",
      function: {
        name: safeName,
        description: tool.description || "",
        parameters: tool.parameters || {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        strict: tool.strict === true,
      },
    });
  };

  for (const tool of responseTools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    if (tool.type === "function" && tool.name) {
      addTool(tool.name, tool);
      continue;
    }
    if (tool.type === "custom" && tool.name) {
      addTool(
        tool.name,
        {
          description: [
            tool.description,
            "This is a Codex freeform custom tool. Pass the exact raw tool input as the `input` string.",
            tool.format?.definition ? `Grammar:\n${tool.format.definition}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Exact raw input for the Codex freeform tool.",
              },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
        { custom: true },
      );
      continue;
    }
    if (tool.type === "namespace" && tool.name && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (nested?.type !== "function" || !nested.name) {
          continue;
        }
        addTool(namespaceToolName(tool.name, nested.name), {
          description: [tool.description, nested.description].filter(Boolean).join("\n\n"),
          parameters: nested.parameters,
          strict: nested.strict,
        });
      }
    }
  }

  return { chatTools, originalToSafe, safeToOriginal, customNames };
}

function textFromPart(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.input_text === "string") {
    return part.input_text;
  }
  if (typeof part.output_text === "string") {
    return part.output_text;
  }
  return "";
}

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.image_url === "string") {
    return part.image_url;
  }
  if (typeof part.image_url?.url === "string") {
    return part.image_url.url;
  }
  if (typeof part.input_image === "string") {
    return part.input_image;
  }
  if (typeof part.url === "string" && (part.type === "image_url" || part.type === "input_image")) {
    return part.url;
  }
  return "";
}

export function responseContentToChatContent(content, { enableVision = false } = {}) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return safeString(content);
  }

  const parts = [];
  for (const part of content) {
    const text = textFromPart(part);
    if (text) {
      parts.push({ type: "text", text });
      continue;
    }
    const imageUrl = imageUrlFromPart(part);
    if (imageUrl && enableVision) {
      parts.push({ type: "image_url", image_url: { url: imageUrl } });
    } else if (imageUrl) {
      parts.push({ type: "text", text: "[image input omitted: set DEEPSEEK_ENABLE_VISION=1 after DeepSeek enables multimodal input]" });
    }
  }

  if (!parts.length) {
    return "";
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts;
}

function outputTextFromItem(item) {
  return responseContentToChatContent(item?.content, { enableVision: false });
}

// Fold any Codex reasoning effort onto the three the bridge exposes.
// none|minimal -> none ; low|medium|high -> high (default) ; xhigh|max -> xhigh.
export function normalizeReasoningEffort(effort) {
  switch (effort) {
    case "none":
    case "minimal":
      return "none";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return "high";
  }
}

export function mapDeepSeekThinking({ effort } = {}) {
  const normalized = normalizeReasoningEffort(effort);
  if (normalized === "none") {
    return { thinking: { type: "disabled" } };
  }
  if (normalized === "xhigh") {
    return { thinking: { type: "enabled" }, reasoning_effort: "max" };
  }
  return { thinking: { type: "enabled" }, reasoning_effort: "high" };
}

export function mapToolChoice(toolChoice, registry, thinking) {
  if (!toolChoice || toolChoice === "auto") {
    return "auto";
  }
  if (toolChoice === "none") {
    return "none";
  }
  if (toolChoice === "required") {
    return thinking === "enabled" ? "auto" : "required";
  }
  const name = toolChoice?.function?.name || toolChoice?.name;
  if (!name) {
    return "auto";
  }
  if (thinking === "enabled") {
    return "auto";
  }
  return {
    type: "function",
    function: {
      name: registry.originalToSafe.get(name) || name,
    },
  };
}

export function buildChatMessages(responseRequest, registry, config) {
  const input = typeof responseRequest.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: responseRequest.input }] }]
    : Array.isArray(responseRequest.input)
      ? responseRequest.input
      : [];

  const messages = [];
  if (typeof responseRequest.instructions === "string" && responseRequest.instructions.trim()) {
    messages.push({ role: "system", content: responseRequest.instructions });
  }

  let pendingReasoningContent = "";
  let pendingToolCalls = [];

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) {
      return;
    }
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    };
    if (pendingReasoningContent) {
      assistant.reasoning_content = pendingReasoningContent;
    }
    messages.push(assistant);
    pendingToolCalls = [];
    pendingReasoningContent = "";
  };

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "reasoning") {
      const state = decodeState(item.encrypted_content);
      pendingReasoningContent = typeof state?.reasoning_content === "string" ? state.reasoning_content : "";
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const originalName = item.name || "tool";
      const safeName = registry.originalToSafe.get(originalName) || originalName;
      const args = item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input || "" })
        : item.arguments || "{}";
      pendingToolCalls.push({
        id: item.call_id || makeId("call"),
        type: "function",
        function: {
          name: safeName,
          arguments: args,
        },
      });
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      flushToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: safeString(item.output),
      });
      continue;
    }
    if (item.type === "message") {
      flushToolCalls();
      const content = responseContentToChatContent(item.content, config);
      if (!content || (Array.isArray(content) && !content.length)) {
        continue;
      }
      const role = item.role === "assistant"
        ? "assistant"
        : item.role === "developer" || item.role === "system"
          ? "system"
          : "user";
      messages.push({ role, content });
    }
  }
  flushToolCalls();
  if (!messages.length) {
    messages.push({ role: "user", content: "" });
  }
  return messages;
}

export function buildDeepSeekRequest(responseRequest, registry, config) {
  const resolvedModel = resolveModelRequest(responseRequest.model, config);
  const thinking = mapDeepSeekThinking({ effort: responseRequest.reasoning?.effort });
  const body = {
    model: resolvedModel.upstreamModel,
    messages: buildChatMessages(responseRequest, registry, config),
    stream: responseRequest.stream === true,
    ...thinking,
  };
  if (registry.chatTools.length) {
    body.tools = registry.chatTools;
    body.tool_choice = mapToolChoice(responseRequest.tool_choice, registry, thinking.thinking.type);
  }
  if (Number.isFinite(responseRequest.max_output_tokens)) {
    body.max_tokens = responseRequest.max_output_tokens;
  }
  if (responseRequest.text?.format?.type === "json_object") {
    body.response_format = { type: "json_object" };
  }
  const userId = responseRequest.metadata?.user_id || responseRequest.client_metadata?.user_id;
  if (userId) {
    body.metadata = { user_id: userId };
  }
  return body;
}

export function createResponseBase(id, request, status = "in_progress") {
  return {
    id,
    object: "response",
    created_at: nowSeconds(),
    status,
    background: false,
    completed_at: status === "completed" ? nowSeconds() : null,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    model: request.model,
    output: [],
    output_text: "",
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    reasoning: request.reasoning ?? null,
    usage: null,
    metadata: request.metadata ?? null,
  };
}

export function makeReasoningItem(reasoningContent) {
  return {
    id: makeId("rs"),
    type: "reasoning",
    encrypted_content: encodeState({ reasoning_content: reasoningContent || "" }),
    summary: [],
  };
}

export function parseCustomInput(argumentsText) {
  try {
    const value = JSON.parse(argumentsText || "{}");
    if (typeof value?.input === "string") {
      return value.input;
    }
  } catch {
    return argumentsText || "";
  }
  return argumentsText || "";
}

export function convertToolCall(toolCall, registry) {
  const safeName = toolCall?.function?.name || "tool";
  const originalName = registry.safeToOriginal.get(safeName) || safeName;
  const callId = toolCall.id || makeId("call");
  const args = toolCall?.function?.arguments || "";
  if (registry.customNames.has(originalName)) {
    return {
      id: makeId("ctc"),
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: originalName,
      input: parseCustomInput(args),
    };
  }
  return {
    id: makeId("fc"),
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: originalName,
    arguments: args,
  };
}

export function convertDeepSeekMessageToItems(message, registry) {
  const output = [];
  const reasoningContent = message?.reasoning_content || "";
  if (reasoningContent || message?.tool_calls?.length) {
    output.push(makeReasoningItem(reasoningContent));
  }
  if (message?.content) {
    output.push({
      id: makeId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text: message.content }],
    });
  }
  for (const toolCall of message?.tool_calls || []) {
    output.push(convertToolCall(toolCall, registry));
  }
  return output;
}

export function responseOutputText(output) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("");
}

export function usageFromDeepSeek(usage) {
  if (!usage) {
    return null;
  }
  const inputDetails = usage.prompt_tokens_details || {};
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? inputDetails.prompt_cache_hit_tokens ?? inputDetails.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? inputDetails.prompt_cache_miss_tokens ?? 0;
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    input_tokens_details: {
      ...inputDetails,
      cached_tokens: cacheHitTokens,
      prompt_cache_hit_tokens: cacheHitTokens,
      prompt_cache_miss_tokens: cacheMissTokens,
    },
    output_tokens_details: usage.completion_tokens_details ?? null,
  };
}

export function outputTextFromResponseItemForTest(item) {
  return outputTextFromItem(item);
}
