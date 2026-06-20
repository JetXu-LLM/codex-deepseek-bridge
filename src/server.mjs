import http from "node:http";
import { createLogger } from "./logger.mjs";
import { catalogModels } from "./models.mjs";
import { extractBearer, readJsonBody, sendError, sendHtml, sendJson } from "./http.mjs";
import { buildPromptDiagnostics } from "./prompt-diagnostics.mjs";
import { reportDataForConfig, reportHtml } from "./report.mjs";
import { dataFromSseFrame, parseSseFrames, writeSse } from "./sse.mjs";
import {
  buildDeepSeekRequest,
  buildToolRegistry,
  convertDeepSeekMessageToItems,
  createResponseBase,
  makeReasoningItem,
  parseCustomInput,
  responseOutputText,
  usageFromDeepSeek,
} from "./translate.mjs";
import { makeId, nowSeconds, redactSecrets } from "./util.mjs";

function upstreamUrl(config) {
  return `${config.deepseekBaseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function resolveApiKey(req, config) {
  const bearer = extractBearer(req.headers);
  if (config.bridgeApiKey) {
    if (bearer !== config.bridgeApiKey) {
      return { error: "Bridge bearer token rejected." };
    }
    return { apiKey: config.apiKey };
  }
  return { apiKey: config.apiKey || bearer };
}

async function callDeepSeek(body, config, apiKey, signal) {
  return fetch(upstreamUrl(config), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: body.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function handleNonStreaming({ res, request, deepSeekBody, registry, config, apiKey, signal, logger, requestId }) {
  const startedAt = Date.now();
  const upstream = await callDeepSeek(deepSeekBody, config, apiKey, signal);
  const text = await upstream.text();
  if (!upstream.ok) {
    logger.requestFailed({
      requestId,
      error: `DeepSeek upstream request failed: ${redactSecrets(text)}`,
      durationMs: Date.now() - startedAt,
      upstreamStatus: upstream.status,
    });
    sendError(res, upstream.status, "DeepSeek upstream request failed", redactSecrets(text).slice(0, 4000));
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    logger.requestFailed({
      requestId,
      error: "DeepSeek returned invalid JSON.",
      durationMs: Date.now() - startedAt,
      upstreamStatus: upstream.status,
    });
    sendError(res, 502, "DeepSeek returned invalid JSON", text.slice(0, 2000));
    return;
  }

  const response = createResponseBase(makeId("resp"), request, "completed");
  const message = json.choices?.[0]?.message || {};
  response.output = convertDeepSeekMessageToItems(message, registry);
  response.output_text = responseOutputText(response.output);
  response.usage = usageFromDeepSeek(json.usage);
  logger.requestCompleted({ requestId, response, durationMs: Date.now() - startedAt });
  sendJson(res, 200, response);
}

async function handleStreaming({ res, request, deepSeekBody, registry, config, apiKey, signal, logger, requestId }) {
  const startedAt = Date.now();
  const upstream = await callDeepSeek(deepSeekBody, config, apiKey, signal);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    logger.requestFailed({
      requestId,
      error: `DeepSeek upstream stream failed: ${redactSecrets(text)}`,
      durationMs: Date.now() - startedAt,
      upstreamStatus: upstream.status || 502,
    });
    sendError(res, upstream.status || 502, "DeepSeek upstream stream failed", redactSecrets(text).slice(0, 4000));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const responseId = makeId("resp");
  const response = createResponseBase(responseId, request, "in_progress");
  let sequenceNumber = 0;
  let outputIndex = 0;
  let reasoningContent = "";
  let reasoningEmitted = false;
  let textItem = null;
  let textContent = "";
  const toolStates = new Map();
  const outputItems = [];
  let usage = null;

  const emit = (event) => {
    sequenceNumber += 1;
    if (!("sequence_number" in event) && event.type !== "response.created" && event.type !== "response.in_progress") {
      event.sequence_number = sequenceNumber;
    }
    writeSse(res, event);
  };

  const emitReasoningIfNeeded = () => {
    if (reasoningEmitted || (!reasoningContent && !toolStates.size)) {
      return;
    }
    reasoningEmitted = true;
    const item = makeReasoningItem(reasoningContent);
    outputItems.push(item);
    const index = outputIndex;
    outputIndex += 1;
    emit({ type: "response.output_item.added", item, output_index: index });
    emit({ type: "response.output_item.done", item, output_index: index });
  };

  const ensureTextItem = () => {
    emitReasoningIfNeeded();
    if (textItem) {
      return textItem;
    }
    textItem = {
      id: makeId("msg"),
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
      output_index: outputIndex,
    };
    outputIndex += 1;
    emit({
      type: "response.output_item.added",
      item: {
        id: textItem.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
      output_index: textItem.output_index,
    });
    emit({
      type: "response.content_part.added",
      item_id: textItem.id,
      output_index: textItem.output_index,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    });
    return textItem;
  };

  const ensureToolState = (index, delta) => {
    const existing = toolStates.get(index);
    if (existing) {
      if (delta.id) {
        existing.call_id = delta.id;
      }
      if (delta.function?.name) {
        existing.safeName = delta.function.name;
        existing.originalName = registry.safeToOriginal.get(delta.function.name) || delta.function.name;
        existing.custom = registry.customNames.has(existing.originalName);
      }
      return existing;
    }

    const safeName = delta.function?.name || `tool_${index}`;
    const originalName = registry.safeToOriginal.get(safeName) || safeName;
    const custom = registry.customNames.has(originalName);
    const state = {
      call_id: delta.id || makeId("call"),
      safeName,
      originalName,
      custom,
      arguments: "",
      item_id: custom ? makeId("ctc") : makeId("fc"),
      output_index: outputIndex,
      added: false,
    };
    outputIndex += 1;
    toolStates.set(index, state);
    return state;
  };

  const emitToolAddedIfNeeded = (state) => {
    if (state.added) {
      return;
    }
    emitReasoningIfNeeded();
    state.added = true;
    emit({
      type: "response.output_item.added",
      output_index: state.output_index,
      item: state.custom
        ? {
            id: state.item_id,
            type: "custom_tool_call",
            status: "in_progress",
            call_id: state.call_id,
            name: state.originalName,
            input: "",
          }
        : {
            id: state.item_id,
            type: "function_call",
            status: "in_progress",
            call_id: state.call_id,
            name: state.originalName,
            arguments: "",
          },
    });
  };

  const emitToolDelta = (state, deltaText) => {
    if (!deltaText) {
      return;
    }
    emitToolAddedIfNeeded(state);
    state.arguments += deltaText;
    if (!state.custom) {
      emit({
        type: "response.function_call_arguments.delta",
        output_index: state.output_index,
        item_id: state.item_id,
        delta: deltaText,
      });
    }
  };

  const finishTextIfNeeded = () => {
    if (!textItem || textItem.status === "completed") {
      return;
    }
    textItem.status = "completed";
    textItem.content = [{ type: "output_text", annotations: [], text: textContent }];
    const item = {
      id: textItem.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: textItem.content,
    };
    outputItems.push(item);
    emit({
      type: "response.output_text.done",
      output_index: textItem.output_index,
      item_id: textItem.id,
      content_index: 0,
      text: textContent,
    });
    emit({
      type: "response.content_part.done",
      output_index: textItem.output_index,
      item_id: textItem.id,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: textContent },
    });
    emit({ type: "response.output_item.done", output_index: textItem.output_index, item });
  };

  const finishTools = () => {
    for (const state of [...toolStates.values()].sort((a, b) => a.output_index - b.output_index)) {
      emitToolAddedIfNeeded(state);
      if (state.custom) {
        const input = parseCustomInput(state.arguments);
        const item = {
          id: state.item_id,
          type: "custom_tool_call",
          status: "completed",
          call_id: state.call_id,
          name: state.originalName,
          input,
        };
        outputItems.push(item);
        if (input) {
          emit({
            type: "response.custom_tool_call_input.delta",
            output_index: state.output_index,
            item_id: state.item_id,
            delta: input,
          });
        }
        emit({
          type: "response.custom_tool_call_input.done",
          output_index: state.output_index,
          item_id: state.item_id,
          input,
        });
        emit({ type: "response.output_item.done", output_index: state.output_index, item });
        continue;
      }

      const item = {
        id: state.item_id,
        type: "function_call",
        status: "completed",
        call_id: state.call_id,
        name: state.originalName,
        arguments: state.arguments,
      };
      outputItems.push(item);
      emit({
        type: "response.function_call_arguments.done",
        output_index: state.output_index,
        item_id: state.item_id,
        arguments: state.arguments,
      });
      emit({ type: "response.output_item.done", output_index: state.output_index, item });
    }
  };

  writeSse(res, { type: "response.created", response });
  writeSse(res, { type: "response.in_progress", response });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const data = dataFromSseFrame(frame);
        if (!data || data === "[DONE]") {
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          usage = usageFromDeepSeek(chunk.usage);
        }
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
        }
        if (typeof delta.content === "string" && delta.content) {
          const item = ensureTextItem();
          textContent += delta.content;
          emit({
            type: "response.output_text.delta",
            output_index: item.output_index,
            item_id: item.id,
            content_index: 0,
            delta: delta.content,
          });
        }
        for (const toolDelta of delta.tool_calls || []) {
          const index = Number.isFinite(toolDelta.index) ? toolDelta.index : 0;
          const state = ensureToolState(index, toolDelta);
          if (toolDelta.id || toolDelta.function?.name) {
            emitToolAddedIfNeeded(state);
          }
          if (typeof toolDelta.function?.arguments === "string") {
            emitToolDelta(state, toolDelta.function.arguments);
          }
        }
      }
    }

    emitReasoningIfNeeded();
    finishTextIfNeeded();
    finishTools();
    const completed = {
      ...response,
      status: "completed",
      completed_at: nowSeconds(),
      output: outputItems,
      output_text: textContent,
      usage,
    };
    logger.requestCompleted({ requestId, response: completed, durationMs: Date.now() - startedAt });
    writeSse(res, { type: "response.completed", response: completed });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.requestFailed({ requestId, error: message, durationMs: Date.now() - startedAt });
    writeSse(res, {
      type: "response.failed",
      response: {
        ...response,
        status: "failed",
        error: { message, type: "bridge_stream_error" },
      },
    });
    res.end();
  }
}

export function modelList(config) {
  const now = nowSeconds();
  return {
    object: "list",
    data: catalogModels({
      customAlias: config.modelAlias,
      customUpstreamModel: config.upstreamModel,
      vision: config.enableVision,
    }).map((model) => ({
      id: model.slug,
      object: "model",
      created: now,
      owned_by: "deepseek",
      display_name: model.display_name,
      description: model.description,
    })),
  };
}

async function handleResponses(req, res, config, logger) {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());

  const requestId = makeId("req");
  const request = await readJsonBody(req);
  const { apiKey, error } = resolveApiKey(req, config);
  if (error) {
    sendError(res, 401, error);
    return;
  }
  if (!apiKey) {
    sendError(res, 401, "Set DEEPSEEK_API_KEY before starting the bridge, or pass it as a bearer token.");
    return;
  }

  const registry = buildToolRegistry(request.tools || []);
  const deepSeekBody = buildDeepSeekRequest(request, registry, config);
  const prompt = buildPromptDiagnostics(deepSeekBody);
  logger.requestStarted({
    requestId,
    request,
    upstream: {
      url: upstreamUrl(config),
      model: deepSeekBody.model,
      stream: deepSeekBody.stream === true,
      thinking: deepSeekBody.thinking,
      tools: Array.isArray(deepSeekBody.tools) ? deepSeekBody.tools.length : 0,
    },
    prompt,
  });

  if (request.stream === true) {
    await handleStreaming({ res, request, deepSeekBody, registry, config, apiKey, signal: controller.signal, logger, requestId });
    return;
  }
  await handleNonStreaming({ res, request, deepSeekBody, registry, config, apiKey, signal: controller.signal, logger, requestId });
}

export async function startServer(config) {
  const logger = createLogger(config);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${config.host}:${config.port}`}`);
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
        sendJson(res, 200, {
          ok: true,
          name: "codex-deepseek-bridge",
          modelAlias: config.modelAlias,
          upstreamModel: config.upstreamModel,
          logging: logger.enabled,
          report: "/report",
        });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/report" || url.pathname === "/dashboard")) {
        sendHtml(res, 200, reportHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/report/data") {
        sendJson(res, 200, reportDataForConfig(config));
        return;
      }
      if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
        sendJson(res, 200, modelList(config));
        return;
      }
      if (req.method === "POST" && (url.pathname === "/responses" || url.pathname === "/v1/responses")) {
        await handleResponses(req, res, config, logger);
        return;
      }
      sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, statusCode, message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  if (!config.quiet) {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    process.stdout.write(
      `Codex DeepSeek Bridge listening on http://${config.host}:${port}\n` +
        `DeepSeek base: ${config.deepseekBaseUrl}\n` +
        `Model alias: ${config.modelAlias} -> ${config.upstreamModel}\n` +
        `Report: http://${config.host}:${port}/report\n`,
    );
  }
  return server;
}
