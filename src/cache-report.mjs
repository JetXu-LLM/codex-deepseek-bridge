import fs from "node:fs";
import path from "node:path";

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyBucket(model) {
  return {
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
}

function addUsage(bucket, usage, cache) {
  const inputDetails = usage?.input_tokens_details || {};
  const hitTokens = cache?.hitTokens ?? inputDetails.prompt_cache_hit_tokens ?? inputDetails.cached_tokens;
  const missTokens = cache?.missTokens ?? inputDetails.prompt_cache_miss_tokens;

  bucket.requests += 1;
  bucket.inputTokens += numberOrZero(usage?.input_tokens);
  bucket.outputTokens += numberOrZero(usage?.output_tokens);
  bucket.totalTokens += numberOrZero(usage?.total_tokens);
  bucket.cacheHitTokens += numberOrZero(hitTokens);
  bucket.cacheMissTokens += numberOrZero(missTokens);
}

function finalizeBucket(bucket) {
  const cacheObservedTokens = bucket.cacheHitTokens + bucket.cacheMissTokens;
  return {
    ...bucket,
    cacheObservedTokens,
    cacheHitRate: cacheObservedTokens > 0 ? bucket.cacheHitTokens / cacheObservedTokens : null,
  };
}

export function loadJsonl(file) {
  const text = fs.readFileSync(file, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function buildCacheReport(events) {
  const requests = new Map();
  const byModel = new Map();
  const overall = emptyBucket("all");
  let completedRequests = 0;

  for (const event of events) {
    if (event?.type === "request.started" && event.requestId) {
      requests.set(event.requestId, event.request || {});
      continue;
    }

    if (event?.type !== "request.completed") {
      continue;
    }

    completedRequests += 1;
    const request = requests.get(event.requestId) || {};
    const model = request.model || event.response?.usage?.model || "unknown";
    const usage = event.response?.usage || {};
    const cache = event.response?.cache || {};

    if (!byModel.has(model)) {
      byModel.set(model, emptyBucket(model));
    }
    addUsage(overall, usage, cache);
    addUsage(byModel.get(model), usage, cache);
  }

  return {
    completedRequests,
    overall: finalizeBucket(overall),
    byModel: [...byModel.values()].map(finalizeBucket).sort((a, b) => b.cacheObservedTokens - a.cacheObservedTokens),
  };
}

function pad(value, width) {
  return String(value).padStart(width, " ");
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRate(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function row(bucket) {
  return [
    bucket.model.padEnd(32, " "),
    pad(bucket.requests, 8),
    pad(formatInteger(bucket.cacheHitTokens), 12),
    pad(formatInteger(bucket.cacheMissTokens), 12),
    pad(formatRate(bucket.cacheHitRate), 9),
    pad(formatInteger(bucket.inputTokens), 12),
    pad(formatInteger(bucket.outputTokens), 12),
  ].join("  ");
}

export function formatCacheReport(report, file) {
  const header = [
    "model".padEnd(32, " "),
    pad("requests", 8),
    pad("hit", 12),
    pad("miss", 12),
    pad("hit rate", 9),
    pad("input", 12),
    pad("output", 12),
  ].join("  ");
  const divider = "-".repeat(header.length);
  const lines = [
    `Cache report for ${file}`,
    "",
    header,
    divider,
    row(report.overall),
  ];

  if (report.byModel.length > 1 || (report.byModel[0] && report.byModel[0].model !== "all")) {
    lines.push(divider);
    for (const bucket of report.byModel) {
      lines.push(row(bucket));
    }
  }

  if (report.completedRequests === 0) {
    lines.push("");
    lines.push("No completed requests found.");
  }

  return `${lines.join("\n")}\n`;
}

export function defaultLogFile(config) {
  if (config.logFile) {
    return config.logFile;
  }
  if (config.logDir) {
    return path.join(config.logDir, "calls.jsonl");
  }
  return "";
}
