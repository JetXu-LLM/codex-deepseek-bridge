import fs from "node:fs";
import path from "node:path";
import { jsonClone, redactSecrets, stableHash } from "./util.mjs";

function ensureDir(dir) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function summarizeRequest(request) {
  return {
    model: request.model,
    stream: request.stream === true,
    inputType: Array.isArray(request.input) ? "array" : typeof request.input,
    inputItems: Array.isArray(request.input) ? request.input.length : undefined,
    tools: Array.isArray(request.tools) ? request.tools.length : 0,
    toolNames: Array.isArray(request.tools)
      ? request.tools.map((tool) => tool?.name || tool?.type).filter(Boolean).slice(0, 40)
      : [],
    reasoning: request.reasoning || null,
    payloadHash: stableHash(JSON.stringify(request)),
  };
}

function summarizeOutput(response) {
  const usage = response?.usage || {};
  const inputDetails = usage.input_tokens_details || {};
  return {
    status: response?.status,
    outputTypes: Array.isArray(response?.output) ? response.output.map((item) => item.type) : [],
    outputNames: Array.isArray(response?.output)
      ? response.output.map((item) => item?.name).filter(Boolean).slice(0, 40)
      : [],
    outputTextLength: typeof response?.output_text === "string" ? response.output_text.length : 0,
    usage,
    cache: {
      hitTokens: inputDetails.prompt_cache_hit_tokens ?? inputDetails.cache_read_input_tokens ?? null,
      missTokens: inputDetails.prompt_cache_miss_tokens ?? null,
    },
  };
}

function maybeRedactedPayload(value, enabled) {
  if (!enabled) {
    return undefined;
  }
  return JSON.parse(redactSecrets(JSON.stringify(jsonClone(value))));
}

export function createLogger(config) {
  if (!config.logDir) {
    return {
      enabled: false,
      write() {},
      requestStarted() {},
      requestCompleted() {},
      requestFailed() {},
    };
  }

  ensureDir(config.logDir);
  const logFile = path.join(config.logDir, "calls.jsonl");

  const write = (event) => {
    const entry = {
      time: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  };

  return {
    enabled: true,
    write,
    requestStarted({ requestId, request, upstream, upstreamRequest, prompt }) {
      write({
        type: "request.started",
        requestId,
        request: summarizeRequest(request),
        upstream,
        prompt,
        payload: maybeRedactedPayload({
          codexRequest: request,
          upstreamRequest,
        }, config.logPayloads),
      });
    },
    requestCompleted({ requestId, response, durationMs, upstreamResponse }) {
      write({
        type: "request.completed",
        requestId,
        durationMs,
        response: summarizeOutput(response),
        payload: maybeRedactedPayload({
          codexResponse: response,
          upstreamResponse,
        }, config.logPayloads),
      });
    },
    requestFailed({ requestId, error, durationMs, upstreamStatus, upstreamResponse }) {
      write({
        type: "request.failed",
        requestId,
        durationMs,
        upstreamStatus,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
        payload: maybeRedactedPayload({ upstreamResponse }, config.logPayloads),
      });
    },
  };
}
