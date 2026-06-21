import fs from "node:fs";
import { buildCacheReport, defaultLogFile, loadJsonl } from "./cache-report.mjs";
import { comparePromptDiagnostics } from "./prompt-diagnostics.mjs";

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(value) {
  return value == null ? null : Math.round(value * 1000) / 10;
}

function cacheFromUsage(usage, cache) {
  const details = usage?.input_tokens_details || {};
  const hitTokens = numberOrZero(cache?.hitTokens ?? details.prompt_cache_hit_tokens ?? details.cached_tokens);
  const missTokens = numberOrZero(cache?.missTokens ?? details.prompt_cache_miss_tokens);
  return {
    hitTokens,
    missTokens,
    observedTokens: hitTokens + missTokens,
    hitRate: hitTokens + missTokens > 0 ? hitTokens / (hitTokens + missTokens) : null,
  };
}

function emptyModel(model) {
  return {
    model,
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    durationMs: 0,
  };
}

function addCallToModel(bucket, call) {
  bucket.calls += 1;
  if (call.status === "failed") {
    bucket.failures += 1;
  }
  bucket.inputTokens += numberOrZero(call.usage?.input_tokens);
  bucket.outputTokens += numberOrZero(call.usage?.output_tokens);
  bucket.totalTokens += numberOrZero(call.usage?.total_tokens);
  bucket.cacheHitTokens += call.cache.hitTokens;
  bucket.cacheMissTokens += call.cache.missTokens;
  bucket.durationMs += numberOrZero(call.durationMs);
}

function finalizeModel(bucket) {
  const cacheObservedTokens = bucket.cacheHitTokens + bucket.cacheMissTokens;
  return {
    ...bucket,
    avgDurationMs: bucket.calls > 0 ? Math.round(bucket.durationMs / bucket.calls) : 0,
    cacheObservedTokens,
    cacheHitRate: cacheObservedTokens > 0 ? bucket.cacheHitTokens / cacheObservedTokens : null,
  };
}

function callsFromEvents(events) {
  const byId = new Map();
  const calls = [];

  for (const event of events) {
    if (!event?.requestId) {
      continue;
    }
    if (event.type === "request.started") {
      const call = {
        id: event.requestId,
        time: event.time,
        status: "started",
        request: event.request || {},
        upstream: event.upstream || {},
        prompt: event.prompt || event.upstream?.prompt || null,
        usage: null,
        cache: cacheFromUsage(null, null),
        durationMs: null,
      };
      byId.set(event.requestId, call);
      calls.push(call);
      continue;
    }

    const call = byId.get(event.requestId) || {
      id: event.requestId,
      time: event.time,
      status: "unknown",
      request: {},
      upstream: {},
      prompt: null,
    };
    if (!byId.has(event.requestId)) {
      byId.set(event.requestId, call);
      calls.push(call);
    }

    if (event.type === "request.completed") {
      call.status = "completed";
      call.durationMs = event.durationMs;
      call.response = event.response || {};
      call.usage = event.response?.usage || null;
      call.cache = cacheFromUsage(call.usage, event.response?.cache);
      call.outputTextLength = event.response?.outputTextLength || 0;
    } else if (event.type === "request.failed") {
      call.status = "failed";
      call.durationMs = event.durationMs;
      call.error = event.error || "";
      call.upstreamStatus = event.upstreamStatus || null;
      call.usage = null;
      call.cache = cacheFromUsage(null, null);
    }
  }

  return calls
    .filter((call) => call.status !== "started")
    .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
}

function attachPrefixComparisons(calls) {
  const lastByStableGroup = new Map();
  for (const call of calls) {
    const prompt = call.prompt;
    if (!prompt) {
      call.prefix = null;
      continue;
    }
    const model = call.upstream?.model || call.request?.model || "unknown";
    const group = `${model}:${prompt.stablePrefixHash || ""}`;
    const previous = lastByStableGroup.get(group);
    call.prefix = comparePromptDiagnostics(previous?.prompt, prompt);
    if (call.prefix) {
      call.prefix.previousRequestId = previous.id;
      call.prefix.previousTime = previous.time;
      call.prefix.risk = prefixRisk(call.prefix);
    }
    lastByStableGroup.set(group, call);
  }
  return calls;
}

function prefixRisk(prefix) {
  if (!prefix) {
    return "unknown";
  }
  if (!prefix.systemStable || !prefix.toolsStable || prefix.previousPromptCovered < 0.5) {
    return "high";
  }
  if (prefix.previousPromptCovered < 0.9) {
    return "medium";
  }
  return "low";
}

function prefixSummary(calls) {
  const compared = calls.filter((call) => call.prefix);
  const highRisk = compared.filter((call) => call.prefix.risk === "high").length;
  const mediumRisk = compared.filter((call) => call.prefix.risk === "medium").length;
  const lowRisk = compared.filter((call) => call.prefix.risk === "low").length;
  const systemChanges = compared.filter((call) => call.prefix.systemStable === false).length;
  const toolChanges = compared.filter((call) => call.prefix.toolsStable === false).length;
  const avgCovered = compared.length
    ? compared.reduce((sum, call) => sum + numberOrZero(call.prefix.previousPromptCovered), 0) / compared.length
    : null;
  const volatileSignals = {};
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.prompt?.volatileSignals || {})) {
      volatileSignals[key] = (volatileSignals[key] || 0) + value;
    }
  }
  return {
    comparedCalls: compared.length,
    lowRisk,
    mediumRisk,
    highRisk,
    systemChanges,
    toolChanges,
    avgPreviousPromptCovered: avgCovered,
    volatileSignals,
  };
}

function recommendations(summary, prefix) {
  const items = [];
  if (summary.totalCalls === 0) {
    items.push("Start the bridge with logging enabled, then run a few Codex turns to collect report data.");
    return items;
  }
  if (summary.cacheHitRate != null && summary.cacheHitRate < 0.4 && summary.inputTokens > 10000) {
    items.push("Cache hit rate is low for a non-trivial prompt volume. Check prefix stability before trying prompt rewriting.");
  }
  if (prefix.highRisk > 0 || prefix.systemChanges > 0 || prefix.toolChanges > 0) {
    items.push("Prompt prefixes are drifting. Keep the same thread, model, tool set, and AGENTS.md instructions stable across related turns.");
  }
  if (Object.keys(prefix.volatileSignals || {}).length) {
    items.push("Volatile values appeared in prompts. If they are injected by the bridge, make them stable; if they come from Codex state, prefer diagnosis before mutation.");
  }
  if (!items.length) {
    items.push("Prefix continuity looks healthy. DeepSeek cache misses are likely from first requests, new context, or server-side cache expiry.");
  }
  return items;
}

export function buildReportData(config, events = []) {
  const calls = attachPrefixComparisons(callsFromEvents(events));
  const byModel = new Map();
  const summary = {
    totalCalls: calls.length,
    completedCalls: calls.filter((call) => call.status === "completed").length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    streamingCalls: calls.filter((call) => call.request?.stream === true || call.upstream?.stream === true).length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    durationMs: 0,
  };

  for (const call of calls) {
    const model = call.upstream?.model || call.request?.model || "unknown";
    if (!byModel.has(model)) {
      byModel.set(model, emptyModel(model));
    }
    addCallToModel(byModel.get(model), call);
    summary.inputTokens += numberOrZero(call.usage?.input_tokens);
    summary.outputTokens += numberOrZero(call.usage?.output_tokens);
    summary.totalTokens += numberOrZero(call.usage?.total_tokens);
    summary.cacheHitTokens += call.cache.hitTokens;
    summary.cacheMissTokens += call.cache.missTokens;
    summary.durationMs += numberOrZero(call.durationMs);
  }

  const cacheObservedTokens = summary.cacheHitTokens + summary.cacheMissTokens;
  summary.cacheObservedTokens = cacheObservedTokens;
  summary.cacheHitRate = cacheObservedTokens > 0 ? summary.cacheHitTokens / cacheObservedTokens : null;
  summary.avgDurationMs = summary.totalCalls > 0 ? Math.round(summary.durationMs / summary.totalCalls) : 0;

  const prefix = prefixSummary(calls);
  return {
    generatedAt: new Date().toISOString(),
    config: {
      host: config.host,
      port: config.port,
      deepseekBaseUrl: config.deepseekBaseUrl,
      modelAlias: config.modelAlias,
      upstreamModel: config.upstreamModel,
      enableVision: config.enableVision,
      apiKeyConfigured: Boolean(config.apiKey),
      logDir: config.logDir || "",
      logPayloads: Boolean(config.logPayloads),
      bridgeApiKeyEnabled: Boolean(config.bridgeApiKey),
    },
    summary: {
      ...summary,
      cacheHitPercent: percent(summary.cacheHitRate),
    },
    cache: buildCacheReport(events),
    prefix,
    recommendations: recommendations(summary, prefix),
    models: [...byModel.values()].map(finalizeModel).sort((a, b) => b.totalTokens - a.totalTokens),
    calls: calls.slice(-200).reverse(),
  };
}

export function readReportEvents(config) {
  const file = defaultLogFile(config);
  if (!file || !fs.existsSync(file)) {
    return { file, events: [], exists: false };
  }
  return { file, events: loadJsonl(file), exists: true };
}

export function reportDataForConfig(config) {
  const { file, events, exists } = readReportEvents(config);
  return {
    logFile: file,
    logFileExists: exists,
    ...buildReportData(config, events),
  };
}

export function reportHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex DeepSeek Bridge Report</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5f7fa;
      --surface: #ffffff;
      --surface-2: #eef2f7;
      --ink: #182230;
      --ink-soft: #344356;
      --muted: #5c6b7d;
      --line: #e2e8f0;
      --line-strong: #d2dbe6;
      --accent: #0a7ea4;
      --accent-soft: rgba(10, 126, 164, 0.12);
      --good: #1a7f4b;
      --warn: #b25e09;
      --bad: #c23a22;
      --track: #e6ecf3;
      --shadow: 0 1px 2px rgba(16, 30, 50, 0.05), 0 8px 24px rgba(16, 30, 50, 0.05);
      --radius: 14px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117;
        --surface: #161c25;
        --surface-2: #1c242f;
        --ink: #e7eef6;
        --ink-soft: #c4d0dd;
        --muted: #95a3b3;
        --line: #28313d;
        --line-strong: #333f4e;
        --accent: #4cc2e8;
        --accent-soft: rgba(76, 194, 232, 0.16);
        --good: #4cc28a;
        --warn: #e0a64a;
        --bad: #ed7d6b;
        --track: #232d39;
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(0, 0, 0, 0.35);
      }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: .92em; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; color: var(--ink-soft); word-break: break-word; }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 0 24px; }

    header.site {
      position: sticky; top: 0; z-index: 20;
      background: color-mix(in srgb, var(--surface) 88%, transparent);
      backdrop-filter: saturate(140%) blur(10px);
      border-bottom: 1px solid var(--line);
    }
    .head-inner { display: flex; align-items: center; gap: 18px; padding: 16px 24px; max-width: 1280px; margin: 0 auto; flex-wrap: wrap; }
    .brand { display: flex; flex-direction: column; gap: 2px; margin-right: auto; }
    .brand h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
    .brand .tag { color: var(--muted); font-size: 12.5px; }
    .head-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 5px 11px; }
    .badge.version { font-variant-numeric: tabular-nums; color: var(--ink-soft); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 0 transparent; }
    .status-dot.on { background: var(--good); animation: pulse 2.4s ease-out infinite; }
    .status-dot.off { background: var(--bad); }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--good) 55%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    .btn { font: inherit; font-size: 12.5px; color: var(--ink-soft); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 9px; padding: 6px 12px; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
    .btn:hover { background: var(--surface-2); border-color: var(--accent); color: var(--ink); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

    main { padding: 26px 0 56px; }
    .stack-v { display: flex; flex-direction: column; gap: 22px; }
    .grid { display: grid; gap: 18px; }
    .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .charts { grid-template-columns: 0.9fr 1.1fr; }
    .charts-2 { grid-template-columns: 1.1fr 0.9fr; }
    .two { grid-template-columns: 1fr 1fr; }

    .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow); }
    .card > h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
    .card > .card-note { margin: 0 0 14px; font-size: 12.5px; color: var(--muted); }

    .kpi { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); }
    .kpi .kpi-label { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
    .kpi .kpi-value { font-size: 30px; font-weight: 680; margin-top: 8px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.05; }
    .kpi .kpi-sub { color: var(--muted); font-size: 12.5px; margin-top: 8px; }

    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .center { text-align: center; }
    .nowrap { white-space: nowrap; }
    .num { font-variant-numeric: tabular-nums; }
    .t-good { color: var(--good); font-weight: 600; }
    .t-warn { color: var(--warn); font-weight: 600; }
    .t-bad { color: var(--bad); font-weight: 600; }
    .t-muted { color: var(--muted); }
    .arrow { color: var(--muted); padding: 0 4px; }

    .chart-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    .donut-value { fill: var(--ink); font-size: 22px; font-weight: 680; font-variant-numeric: tabular-nums; }
    .donut-sub { fill: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; }
    .donut-arc { transition: stroke-dashoffset .9s cubic-bezier(.22,.61,.36,1); }
    .tone-good { color: var(--good); }
    .tone-warn { color: var(--warn); }
    .tone-bad { color: var(--bad); }
    .tone-muted { color: var(--muted); }

    .legend { display: flex; flex-direction: column; gap: 7px; }
    .leg { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-soft); }
    .leg .num { color: var(--muted); margin-left: auto; }
    .dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
    .dot-good { background: var(--good); } .dot-warn { background: var(--warn); } .dot-bad { background: var(--bad); } .dot-muted { background: var(--muted); }

    .seg-wrap { border-radius: 7px; overflow: hidden; border: 1px solid var(--line); }
    .seg rect { transition: width .7s ease; }
    .seg-good { fill: var(--good); } .seg-warn { fill: var(--warn); } .seg-bad { fill: var(--bad); }
    .bar-empty { padding: 20px; border: 1px dashed var(--line-strong); border-radius: 10px; color: var(--muted); background: var(--surface-2); font-size: 13px; text-align: center; }

    .hbars { display: flex; flex-direction: column; gap: 12px; }
    .hbar-row { display: grid; grid-template-columns: minmax(80px, 0.9fr) 1fr auto; align-items: center; gap: 12px; }
    .hbar-label { font-size: 12.5px; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hbar-label code { background: none; border: none; padding: 0; color: var(--ink-soft); }
    .hbar-track { height: 12px; background: var(--track); border-radius: 999px; overflow: hidden; }
    .hbar-fill { height: 100%; width: 0; background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #ffffff)); border-radius: 999px; transition: width .8s cubic-bezier(.22,.61,.36,1); }
    .hbar-value { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 56px; text-align: right; }

    .spark { display: block; }
    .spark-area { fill: var(--accent-soft); stroke: none; }
    .spark-line { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1s ease forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .spark-meta { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 8px; }

    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th { text-align: left; padding: 9px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); white-space: nowrap; }
    tbody td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    .calls-table tbody tr.call-row { cursor: pointer; transition: background .12s ease; }
    .calls-table tbody tr.call-row:hover { background: var(--surface-2); }
    .calls-table tbody tr.call-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .calls-table tr.call-row td:first-child { width: 22px; }
    .chev { display: inline-block; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .2s ease; margin-top: 3px; }
    .call-row.open .chev { transform: rotate(45deg); }
    .call-detail { display: none; }
    .call-detail.open { display: table-row; }
    .call-detail > td { background: var(--surface-2); padding: 0; }
    .detail-inner { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding: 18px 14px; animation: fadeIn .25s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
    .dgroup h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
    dl.kvs { margin: 0; display: grid; gap: 6px; }
    .kv { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: baseline; }
    .kv dt { color: var(--muted); font-size: 12.5px; }
    .kv dd { margin: 0; text-align: right; font-size: 12.5px; color: var(--ink-soft); font-variant-numeric: tabular-nums; word-break: break-word; }
    .err { color: var(--bad); }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }
    .chip { font-size: 11.5px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; color: var(--ink-soft); }

    .chiprow { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
    .metric { flex: 1 1 120px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--surface-2); }
    .metric-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .metric-value { display: block; font-size: 18px; font-weight: 640; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .recs { margin: 6px 0 0; padding-left: 18px; color: var(--ink-soft); }
    .recs li { margin-bottom: 7px; }
    h3.sub { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }

    .empty-banner { text-align: center; padding: 44px 24px; }
    .empty-banner h2 { margin: 0 0 8px; font-size: 18px; color: var(--ink); text-transform: none; letter-spacing: 0; }
    .empty-banner p { margin: 0 auto 16px; max-width: 520px; color: var(--muted); }
    .empty-steps { display: inline-grid; gap: 8px; text-align: left; color: var(--ink-soft); font-size: 13px; }
    .empty-steps li { margin-left: 18px; }
    #loadError { margin: 0 0 6px; color: var(--bad); font-size: 12.5px; }

    @media (max-width: 1000px) {
      .kpis { grid-template-columns: repeat(2, 1fr); }
      .charts, .charts-2, .two { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .kpis { grid-template-columns: 1fr; }
      .wrap, .head-inner, main .wrap { padding-left: 16px; padding-right: 16px; }
      .kpi .kpi-value { font-size: 26px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, .donut-arc, .hbar-fill, .spark-line, .seg rect { transition: none !important; animation: none !important; }
      .spark-line { stroke-dashoffset: 0; }
    }
  </style>
</head>
<body>
  <header class="site">
    <div class="head-inner">
      <div class="brand">
        <h1>Codex DeepSeek Bridge</h1>
        <span class="tag">Local report for DeepSeek calls, tokens, cache hits, and prompt-prefix stability</span>
      </div>
      <div class="head-meta">
        <span class="badge"><span class="status-dot" id="statusDot"></span><span id="statusLabel">Connecting</span></span>
        <span class="badge version" id="version" style="display:none"></span>
        <span class="badge" id="genAt">Loading</span>
        <button class="btn" id="autoBtn" type="button" aria-pressed="true">Auto-refresh: On</button>
        <button class="btn" id="refreshBtn" type="button">Refresh</button>
      </div>
    </div>
  </header>
  <main>
    <div class="wrap stack-v">
      <p id="loadError" style="display:none"></p>

      <section id="emptyState" class="card empty-banner" style="display:none">
        <h2>No calls recorded yet</h2>
        <p>This report fills in once the bridge has logged a few requests. Everything shown here stays on your machine.</p>
        <ol class="empty-steps">
          <li>Start the bridge with request logging enabled.</li>
          <li>Run a few Codex turns against the DeepSeek models.</li>
          <li>Reload this page to see tokens, cache hits, and prefix health.</li>
        </ol>
      </section>

      <section id="dashboard" class="stack-v">
        <section class="grid kpis" id="kpis"></section>
        <section class="grid charts">
          <div class="card">
            <h2>Cache hit rate</h2>
            <p class="card-note">Share of input tokens served from the DeepSeek prompt cache.</p>
            <div id="chartCache"></div>
          </div>
          <div class="card">
            <h2>Prefix risk</h2>
            <p class="card-note">Continuity of the cached prompt prefix across compared turns.</p>
            <div id="chartRisk"></div>
          </div>
        </section>
        <section class="grid charts-2">
          <div class="card">
            <h2>Tokens by model</h2>
            <p class="card-note">Total tokens handled per upstream model.</p>
            <div id="chartModels"></div>
          </div>
          <div class="card">
            <h2>Latency trend</h2>
            <p class="card-note">Per-call duration in chronological order.</p>
            <div id="chartSpark"></div>
          </div>
        </section>
        <section class="card">
          <h2>Models</h2>
          <div id="models"></div>
        </section>
        <section class="card">
          <h2>Recent calls</h2>
          <p class="card-note">Select a row to view its full metadata. No prompt text is stored or shown.</p>
          <div id="calls"></div>
        </section>
      </section>

      <section class="grid two">
        <div class="card">
          <h2>Setup</h2>
          <div id="setup"></div>
        </div>
        <div class="card">
          <h2>Prefix health and suggestions</h2>
          <div id="recs"></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    var NF = new Intl.NumberFormat('en-US');
    var state = { auto: true, timer: null, expanded: new Set() };

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
    function fmt(v) { return NF.format(num(v)); }
    function pctText(v, fallback) { return v == null ? (fallback || 'No data') : (v * 100).toFixed(1) + '%'; }
    function msText(v) { return v == null ? '-' : NF.format(Math.round(num(v))) + ' ms'; }
    function cap(s) { s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function rateTone(v) { if (v == null) return 'muted'; if (v >= 0.75) return 'good'; if (v >= 0.4) return 'warn'; return 'bad'; }
    function riskTone(r) { return r === 'high' ? 'bad' : r === 'medium' ? 'warn' : r === 'low' ? 'good' : 'muted'; }
    function toneSpan(tone, label) { return '<span class="t-' + tone + '">' + esc(label) + '</span>'; }
    function muted(t) { return '<span class="muted">' + esc(t) + '</span>'; }
    function code(v) { return v ? '<code>' + esc(v) + '</code>' : muted('unknown'); }
    function boolText(v, on, off) { return v ? (on || 'On') : (off || 'Off'); }
    function fullTime(iso) { if (!iso) return '-'; var d = new Date(iso); return isNaN(d.getTime()) ? esc(iso) : d.toLocaleString(); }
    function shortTime(iso) {
      if (!iso) return '-';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return esc(iso);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    var VOL_LABELS = { isoTimestamps: 'ISO timestamps', clockTimes: 'Clock times', tempPaths: 'Temp paths', uuids: 'UUIDs' };
    function volLabel(k) { return VOL_LABELS[k] || k; }

    function kpi(label, value, sub) {
      return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + value + '</div><div class="kpi-sub">' + sub + '</div></div>';
    }
    function emptyMsg(t) { return '<div class="bar-empty">' + esc(t) + '</div>'; }
    function table(headers, rows) {
      if (!rows.length) return emptyMsg('No data yet.');
      return '<div class="table-wrap"><table><thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }

    function donut(rate) {
      var size = 132, stroke = 14, r = (size - stroke) / 2, c = 2 * Math.PI * r;
      var has = rate != null;
      var frac = has ? Math.max(0, Math.min(1, rate)) : 0;
      var tone = rateTone(rate);
      var center = has ? (rate * 100).toFixed(rate >= 0.0995 ? 0 : 1) + '%' : 'No data';
      var off = c * (1 - frac);
      var cx = size / 2;
      return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" role="img" aria-label="Cache hit rate ' + esc(center) + '">' +
        '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--track)" stroke-width="' + stroke + '"></circle>' +
        '<circle class="donut-arc tone-' + tone + '" cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="currentColor" stroke-width="' + stroke +
        '" stroke-linecap="round" transform="rotate(-90 ' + cx + ' ' + cx + ')" stroke-dasharray="' + c.toFixed(2) +
        '" stroke-dashoffset="' + c.toFixed(2) + '" data-offset="' + off.toFixed(2) + '"></circle>' +
        '<text x="50%" y="49%" text-anchor="middle" dominant-baseline="middle" class="donut-value">' + esc(center) + '</text>' +
        '<text x="50%" y="64%" text-anchor="middle" class="donut-sub">hit rate</text>' +
        '</svg>';
    }

    function riskBar(p) {
      var low = num(p.lowRisk), med = num(p.mediumRisk), high = num(p.highRisk);
      var total = low + med + high;
      var bar;
      if (total === 0) {
        bar = '<div class="bar-empty">No prefix comparisons yet</div>';
      } else {
        var lw = low / total * 100, mw = med / total * 100, hw = high / total * 100;
        bar = '<div class="seg-wrap"><svg class="seg" viewBox="0 0 100 12" preserveAspectRatio="none" width="100%" height="14" role="img" aria-label="Prefix risk distribution">' +
          (low ? '<rect class="seg-good" x="0" y="0" width="' + lw.toFixed(2) + '" height="12"></rect>' : '') +
          (med ? '<rect class="seg-warn" x="' + lw.toFixed(2) + '" y="0" width="' + mw.toFixed(2) + '" height="12"></rect>' : '') +
          (high ? '<rect class="seg-bad" x="' + (lw + mw).toFixed(2) + '" y="0" width="' + hw.toFixed(2) + '" height="12"></rect>' : '') +
          '</svg></div>';
      }
      var legend = '<div class="legend" style="margin-top:14px">' +
        legItem('good', 'Low risk', low) +
        legItem('warn', 'Medium risk', med) +
        legItem('bad', 'High risk', high) +
        '</div>' +
        '<p class="muted small" style="margin:12px 0 0">' + fmt(p.comparedCalls) + ' compared turns</p>';
      return bar + legend;
    }
    function legItem(tone, label, count) {
      return '<span class="leg"><i class="dot dot-' + tone + '"></i>' + esc(label) + '<span class="num">' + fmt(count) + '</span></span>';
    }

    function modelBars(models) {
      if (!models.length) return emptyMsg('No model activity yet');
      var top = models.slice(0, 8);
      var max = Math.max.apply(null, top.map(function (m) { return num(m.totalTokens); }).concat([1]));
      return '<div class="hbars">' + top.map(function (m) {
        var val = num(m.totalTokens);
        var w = max > 0 && val > 0 ? Math.max(3, val / max * 100) : 0;
        return '<div class="hbar-row">' +
          '<div class="hbar-label" title="' + esc(m.model) + '"><code>' + esc(m.model) + '</code></div>' +
          '<div class="hbar-track"><div class="hbar-fill" data-w="' + w.toFixed(2) + '%"></div></div>' +
          '<div class="hbar-value">' + fmt(val) + '</div>' +
          '</div>';
      }).join('') + '</div>';
    }

    function sparkline(calls) {
      var pts = calls.filter(function (c) { return c.durationMs != null; }).slice().reverse();
      if (pts.length < 2) return emptyMsg('Not enough completed calls for a trend yet');
      var w = 600, h = 120, pad = 8;
      var vals = pts.map(function (c) { return num(c.durationMs); });
      var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
      var range = max - min || 1;
      var step = pts.length > 1 ? (w - 2 * pad) / (pts.length - 1) : 0;
      var coords = vals.map(function (v, i) {
        var x = pad + i * step;
        var y = pad + (1 - (v - min) / range) * (h - 2 * pad);
        return [x, y];
      });
      var line = coords.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      var area = 'M' + coords[0][0].toFixed(1) + ' ' + (h - pad) + ' ' +
        coords.map(function (p) { return 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') +
        ' L' + coords[coords.length - 1][0].toFixed(1) + ' ' + (h - pad) + ' Z';
      return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" width="100%" height="120" role="img" aria-label="Latency trend">' +
        '<path class="spark-area" d="' + area + '"></path>' +
        '<path class="spark-line" pathLength="1" d="' + line + '"></path>' +
        '</svg>' +
        '<div class="spark-meta"><span>min ' + msText(min) + '</span><span>max ' + msText(max) + '</span></div>';
    }

    function dl(label, value) { return '<div class="kv"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>'; }
    function group(title, rows) {
      var inner = rows.filter(Boolean).join('');
      if (!inner) return '';
      return '<div class="dgroup"><h4>' + esc(title) + '</h4><dl class="kvs">' + inner + '</dl></div>';
    }
    function chips(items) {
      if (!items || !items.length) return muted('None');
      return '<div class="chips">' + items.map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>';
    }

    function callDetail(c) {
      c = c || {};
      var req = c.request || {}, up = c.upstream || {}, usage = c.usage || {}, det = usage.input_tokens_details || {};
      var cache = c.cache || {}, pf = c.prefix, prompt = c.prompt || {};
      var toolNames = Array.isArray(req.toolNames) ? req.toolNames : (Array.isArray(prompt.toolNames) ? prompt.toolNames : []);
      var toolCount = toolNames.length || num(Array.isArray(req.tools) ? req.tools.length : 0);
      var effort = (req.reasoning && req.reasoning.effort) ? req.reasoning.effort : (up.reasoning_effort || '');
      var thinking = (up.thinking && up.thinking.type) ? up.thinking.type : '';
      var streaming = req.stream === true || up.stream === true;

      var timing = group('Timing', [
        dl('Started', esc(fullTime(c.time))),
        dl('Duration', esc(msText(c.durationMs))),
        (pf && pf.previousTime) ? dl('Previous request', esc(fullTime(pf.previousTime))) : ''
      ]);

      var model = group('Model and reasoning', [
        dl('Request model', code(req.model)),
        dl('Upstream model', code(up.model)),
        dl('Reasoning effort', effort ? esc(effort) : muted('Not set')),
        dl('Thinking', thinking ? esc(thinking) : muted('Off')),
        dl('Streaming', esc(boolText(streaming, 'Yes', 'No')))
      ]);

      var tokens = group('Tokens', [
        dl('Input', esc(fmt(usage.input_tokens))),
        dl('Output', esc(fmt(usage.output_tokens))),
        dl('Total', esc(fmt(usage.total_tokens))),
        dl('Cached input', esc(fmt(cache.hitTokens))),
        dl('Uncached input', esc(fmt(cache.missTokens))),
        (det && det.cached_tokens != null) ? dl('Provider cached', esc(fmt(det.cached_tokens))) : '',
        dl('Output text length', esc(fmt(c.outputTextLength)))
      ]);

      var cacheG = group('Cache', [
        dl('Hit rate', toneSpan(rateTone(cache.hitRate), pctText(cache.hitRate))),
        dl('Hit tokens', esc(fmt(cache.hitTokens))),
        dl('Miss tokens', esc(fmt(cache.missTokens)))
      ]);

      var prefixG = pf ? group('Prefix continuity', [
        dl('Risk', toneSpan(riskTone(pf.risk), pf.risk ? cap(pf.risk) : 'Unknown')),
        dl('Previous prompt covered', esc(pctText(pf.previousPromptCovered))),
        dl('Common prefix messages', esc(fmt(pf.commonPrefixMessages))),
        (pf.commonPrefixChars != null) ? dl('Common prefix characters', esc(fmt(pf.commonPrefixChars))) : '',
        dl('System prompt', toneSpan(pf.systemStable === false ? 'bad' : 'good', pf.systemStable === false ? 'Changed' : 'Stable')),
        dl('Tools', toneSpan(pf.toolsStable === false ? 'bad' : 'good', pf.toolsStable === false ? 'Changed' : 'Stable')),
        (pf.roleSequenceStable != null) ? dl('Role sequence', toneSpan(pf.roleSequenceStable ? 'good' : 'warn', pf.roleSequenceStable ? 'Stable' : 'Changed')) : ''
      ]) : group('Prefix continuity', [dl('Status', muted('First comparable call in its group'))]);

      var vol = prompt.volatileSignals || {};
      var volKeys = Object.keys(vol);
      var volG = group('Volatile signals in prompt', [
        volKeys.length
          ? volKeys.map(function (k) { return dl(volLabel(k), esc(fmt(vol[k]))); }).join('')
          : dl('Detected', muted('None'))
      ]);

      var shape = group('Request shape', [
        dl('Streaming', esc(boolText(streaming, 'Yes', 'No'))),
        dl('Tool count', esc(fmt(toolCount))),
        dl('Tools', chips(toolNames))
      ]);

      var fail = (c.status === 'failed' || c.error) ? group('Failure', [
        dl('Error', '<span class="err">' + esc(c.error || 'Unknown error') + '</span>'),
        (c.upstreamStatus != null) ? dl('Upstream status', esc(String(c.upstreamStatus))) : ''
      ]) : '';

      return '<div class="detail-inner">' + timing + model + tokens + cacheG + prefixG + volG + shape + fail + '</div>';
    }

    function renderCalls(calls) {
      if (!calls.length) return emptyMsg('No calls recorded yet.');
      var rows = calls.map(function (c) {
        var open = state.expanded.has(c.id);
        var up = c.upstream || {}, req = c.request || {}, usage = c.usage || {}, cache = c.cache || {}, pf = c.prefix;
        var effort = (req.reasoning && req.reasoning.effort) ? req.reasoning.effort : (up.reasoning_effort || '');
        var statusTone = c.status === 'failed' ? 'bad' : (c.status === 'completed' ? 'good' : 'muted');
        var summary =
          '<tr class="call-row' + (open ? ' open' : '') + '" data-id="' + esc(c.id) + '" tabindex="0" role="button" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<td><span class="chev" aria-hidden="true"></span></td>' +
          '<td class="nowrap">' + esc(shortTime(c.time)) + '<div class="muted small">' + esc(c.id) + '</div></td>' +
          '<td>' + code(up.model || req.model) + '</td>' +
          '<td>' + (effort ? esc(effort) : muted('-')) + '</td>' +
          '<td>' + toneSpan(statusTone, cap(c.status || 'unknown')) + '<div class="muted small">' + esc(msText(c.durationMs)) + '</div></td>' +
          '<td class="num">' + fmt(usage.input_tokens) + ' in<div class="muted small">' + fmt(usage.output_tokens) + ' out</div></td>' +
          '<td>' + toneSpan(rateTone(cache.hitRate), pctText(cache.hitRate, '-')) + '</td>' +
          '<td>' + toneSpan(riskTone(pf && pf.risk), (pf && pf.risk) ? cap(pf.risk) : 'First') + '</td>' +
          '</tr>';
        var detail = '<tr class="call-detail' + (open ? ' open' : '') + '"><td colspan="8">' + callDetail(c) + '</td></tr>';
        return summary + detail;
      });
      return '<div class="table-wrap"><table class="calls-table"><thead><tr>' +
        '<th aria-hidden="true"></th><th>Time</th><th>Model</th><th>Effort</th><th>Status</th><th>Tokens</th><th>Cache</th><th>Prefix</th>' +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }

    function renderSetup(data) {
      var cfg = data.config || {};
      var port = cfg.port != null ? cfg.port : '8787';
      return '<dl class="kvs">' +
        dl('DeepSeek key', cfg.apiKeyConfigured ? toneSpan('good', 'Stored') : toneSpan('bad', 'Not stored')) +
        dl('Upstream base URL', code(cfg.deepseekBaseUrl)) +
        dl('Model mapping', code(cfg.modelAlias) + '<span class="arrow">-&gt;</span>' + code(cfg.upstreamModel)) +
        dl('Local report URL', code('http://localhost:' + port + '/report')) +
        dl('Log file', (data.logFile ? code(data.logFile) : muted('Not configured')) + ' ' + (data.logFileExists ? toneSpan('good', 'exists') : toneSpan('warn', 'not created yet'))) +
        dl('Payload logging', cfg.logPayloads ? toneSpan('warn', 'On') : toneSpan('good', 'Off')) +
        dl('Vision input', cfg.enableVision ? toneSpan('good', 'On') : muted('Off')) +
        dl('Bridge bearer auth', cfg.bridgeApiKeyEnabled ? toneSpan('good', 'On') : muted('Off')) +
        dl('Port', code(String(port))) +
        '</dl>';
    }

    function renderRecs(data) {
      var p = data.prefix || {};
      var recs = Array.isArray(data.recommendations) ? data.recommendations : [];
      var metrics = '<div class="chiprow">' +
        metric('Compared turns', fmt(p.comparedCalls)) +
        metric('Avg prefix covered', pctText(p.avgPreviousPromptCovered, 'No data')) +
        metric('System changes', fmt(p.systemChanges)) +
        metric('Tool changes', fmt(p.toolChanges)) +
        '</div>';
      var vol = p.volatileSignals || {};
      var volKeys = Object.keys(vol);
      var volBlock = volKeys.length
        ? '<h3 class="sub">Volatile signals in prompts</h3><div class="legend">' +
            volKeys.map(function (k) { return '<span class="leg">' + esc(volLabel(k)) + '<span class="num">' + fmt(vol[k]) + '</span></span>'; }).join('') +
          '</div>'
        : '';
      var sug = '<h3 class="sub">Suggestions</h3>' +
        (recs.length ? '<ul class="recs">' + recs.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '<p class="muted">No suggestions right now.</p>');
      return metrics + volBlock + sug;
    }
    function metric(label, value) {
      return '<div class="metric"><span class="metric-label">' + esc(label) + '</span><span class="metric-value">' + value + '</span></div>';
    }

    function animateIn() {
      requestAnimationFrame(function () {
        var fills = document.querySelectorAll('.hbar-fill[data-w]');
        for (var i = 0; i < fills.length; i++) { fills[i].style.width = fills[i].getAttribute('data-w'); }
        var arcs = document.querySelectorAll('.donut-arc[data-offset]');
        for (var j = 0; j < arcs.length; j++) { arcs[j].style.strokeDashoffset = arcs[j].getAttribute('data-offset'); }
      });
    }

    function render(data) {
      var cfg = data.config || {};
      var s = data.summary || {};
      var prefix = data.prefix || {};
      var models = Array.isArray(data.models) ? data.models : [];
      var calls = Array.isArray(data.calls) ? data.calls : [];

      var genEl = document.getElementById('genAt');
      genEl.textContent = 'Generated ' + fullTime(data.generatedAt);
      var verEl = document.getElementById('version');
      if (data.bridgeVersion) { verEl.textContent = 'v' + data.bridgeVersion; verEl.style.display = ''; }
      else { verEl.style.display = 'none'; }

      var empty = num(s.totalCalls) === 0;
      document.getElementById('dashboard').style.display = empty ? 'none' : '';
      document.getElementById('emptyState').style.display = empty ? '' : 'none';

      document.getElementById('setup').innerHTML = renderSetup(data);
      document.getElementById('recs').innerHTML = renderRecs(data);

      if (!empty) {
        document.getElementById('kpis').innerHTML = [
          kpi('Total calls', fmt(s.totalCalls), fmt(s.completedCalls) + ' completed, ' + fmt(s.failedCalls) + ' failed, ' + fmt(s.streamingCalls) + ' streaming'),
          kpi('Cache hit rate', toneSpan(rateTone(s.cacheHitRate), pctText(s.cacheHitRate)), fmt(s.cacheHitTokens) + ' cached / ' + fmt(s.cacheMissTokens) + ' uncached tokens'),
          kpi('Tokens', fmt(s.totalTokens), fmt(s.inputTokens) + ' input / ' + fmt(s.outputTokens) + ' output'),
          kpi('Average latency', msText(s.avgDurationMs), 'across ' + fmt(s.totalCalls) + ' calls')
        ].join('');

        document.getElementById('chartCache').innerHTML =
          '<div class="chart-row"><div>' + donut(s.cacheHitRate) + '</div>' +
          '<div class="legend">' +
          legItem('good', 'Cached tokens', s.cacheHitTokens) +
          legItem('muted', 'Uncached tokens', s.cacheMissTokens) +
          '<span class="leg muted small">' + fmt(s.cacheObservedTokens) + ' observed</span>' +
          '</div></div>';
        document.getElementById('chartRisk').innerHTML = riskBar(prefix);
        document.getElementById('chartModels').innerHTML = modelBars(models);
        document.getElementById('chartSpark').innerHTML = sparkline(calls);

        document.getElementById('models').innerHTML = table(
          ['Model', 'Calls', 'Failures', 'Input', 'Output', 'Total', 'Cache hit', 'Avg latency'],
          models.map(function (m) {
            return '<tr><td>' + code(m.model) + '</td>' +
              '<td class="num">' + fmt(m.calls) + '</td>' +
              '<td class="num">' + fmt(m.failures) + '</td>' +
              '<td class="num">' + fmt(m.inputTokens) + '</td>' +
              '<td class="num">' + fmt(m.outputTokens) + '</td>' +
              '<td class="num">' + fmt(m.totalTokens) + '</td>' +
              '<td>' + toneSpan(rateTone(m.cacheHitRate), pctText(m.cacheHitRate)) +
              '<div class="muted small">' + fmt(m.cacheHitTokens) + ' / ' + fmt(m.cacheMissTokens) + '</div></td>' +
              '<td class="num">' + esc(msText(m.avgDurationMs)) + '</td></tr>';
          })
        );

        document.getElementById('calls').innerHTML = renderCalls(calls);
      }
      animateIn();
    }

    function setStatus(online, msg) {
      var dot = document.getElementById('statusDot');
      var label = document.getElementById('statusLabel');
      dot.className = 'status-dot ' + (online ? 'on' : 'off');
      label.textContent = online ? 'Live' : 'Offline';
      var errEl = document.getElementById('loadError');
      if (online) { errEl.style.display = 'none'; errEl.textContent = ''; }
      else {
        errEl.style.display = '';
        errEl.textContent = 'Could not reach the bridge' + (msg ? ' (' + msg + ')' : '') + '. Showing the last loaded data.';
      }
    }

    var loadedOnce = false;
    async function load() {
      try {
        var res = await fetch('/report/data', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        render(data);
        setStatus(true);
        loadedOnce = true;
      } catch (err) {
        setStatus(false, err && err.message ? err.message : 'network error');
        if (!loadedOnce) {
          document.getElementById('emptyState').style.display = 'none';
          document.getElementById('dashboard').style.display = 'none';
        }
      }
    }

    function startAuto() { stopAuto(); if (state.auto) { state.timer = setInterval(load, 5000); } }
    function stopAuto() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
    function updateAutoBtn() {
      var b = document.getElementById('autoBtn');
      b.textContent = 'Auto-refresh: ' + (state.auto ? 'On' : 'Off');
      b.setAttribute('aria-pressed', state.auto ? 'true' : 'false');
    }

    function onCallToggle(e) {
      var callsEl = document.getElementById('calls');
      var row = e.target.closest ? e.target.closest('.call-row') : null;
      if (!row || !callsEl.contains(row)) return;
      var id = row.getAttribute('data-id');
      var detail = row.nextElementSibling;
      var nowOpen = !row.classList.contains('open');
      row.classList.toggle('open', nowOpen);
      row.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      if (detail && detail.classList.contains('call-detail')) detail.classList.toggle('open', nowOpen);
      if (nowOpen) state.expanded.add(id); else state.expanded.delete(id);
    }

    function init() {
      document.getElementById('refreshBtn').addEventListener('click', load);
      document.getElementById('autoBtn').addEventListener('click', function () {
        state.auto = !state.auto; updateAutoBtn(); startAuto();
      });
      var callsEl = document.getElementById('calls');
      callsEl.addEventListener('click', onCallToggle);
      callsEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          var row = e.target.closest ? e.target.closest('.call-row') : null;
          if (row) { e.preventDefault(); onCallToggle(e); }
        }
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopAuto(); else { startAuto(); if (state.auto) load(); }
      });
      updateAutoBtn();
      load();
      startAuto();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  </script>
</body>
</html>`;
}
