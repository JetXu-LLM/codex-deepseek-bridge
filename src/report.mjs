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
    :root { color-scheme: light; --ink:#17202a; --muted:#627083; --line:#d9e1ea; --bg:#f7f9fb; --panel:#ffffff; --accent:#0b7fab; --good:#127a4a; --warn:#a16207; --bad:#b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 28px 32px 18px; background: #ffffff; border-bottom: 1px solid var(--line); }
    main { padding: 24px 32px 40px; max-width: 1440px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 16px; }
    .subtle { color: var(--muted); }
    .grid { display: grid; gap: 16px; }
    .kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .two { grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .kpi-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .kpi-value { font-size: 26px; font-weight: 700; margin-top: 8px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; color: var(--muted); background: #fff; }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 12px; color: var(--muted); font-weight: 650; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; padding: 12px; background: #f1f5f8; border: 1px solid var(--line); border-radius: 6px; overflow: auto; }
    .bar { height: 8px; border-radius: 999px; background: #e8eef4; overflow: hidden; }
    .bar > span { display:block; height: 100%; background: var(--accent); width: 0%; }
    .stack { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .list { margin: 0; padding-left: 18px; color: var(--muted); }
    .empty { padding: 28px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); background: #fff; }
    @media (max-width: 980px) { .kpis, .two { grid-template-columns: 1fr; } header, main { padding-left: 18px; padding-right: 18px; } }
  </style>
</head>
<body>
  <header>
    <h1>Codex DeepSeek Bridge Report</h1>
    <div class="subtle">Local-only observability for DeepSeek calls, tokens, cache hits, and prompt-prefix stability.</div>
  </header>
  <main class="grid">
    <section class="grid kpis" id="kpis"></section>
    <section class="grid two">
      <div class="panel">
        <h2>Cache And Prefix Health</h2>
        <div id="cacheHealth"></div>
      </div>
      <div class="panel">
        <h2>Setup</h2>
        <div id="setup"></div>
      </div>
    </section>
    <section class="panel">
      <h2>Models</h2>
      <div id="models"></div>
    </section>
    <section class="panel">
      <h2>Recent Calls</h2>
      <div id="calls"></div>
    </section>
  </main>
  <script>
    const fmt = new Intl.NumberFormat("en-US");
    const pct = (v) => v == null ? "n/a" : (v * 100).toFixed(1) + "%";
    const ms = (v) => v == null ? "n/a" : fmt.format(v) + " ms";
    const cls = (rate) => rate == null ? "" : rate >= .75 ? "good" : rate >= .4 ? "warn" : "bad";
    function text(value) { return value == null || value === "" ? "n/a" : String(value); }
    function kpi(label, value, hint = "") { return '<div class="panel"><div class="kpi-label">' + label + '</div><div class="kpi-value">' + value + '</div><div class="subtle">' + hint + '</div></div>'; }
    function table(headers, rows) {
      if (!rows.length) return '<div class="empty">No data yet.</div>';
      return '<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }
    function riskClass(risk) { return risk === "high" ? "bad" : risk === "medium" ? "warn" : risk === "low" ? "good" : ""; }
    async function load() {
      const data = await fetch('/report/data', { cache: 'no-store' }).then(r => r.json());
      const s = data.summary;
      document.getElementById('kpis').innerHTML = [
        kpi('Calls', fmt.format(s.totalCalls), s.failedCalls + ' failed'),
        kpi('Cache Hit Rate', '<span class="' + cls(s.cacheHitRate) + '">' + pct(s.cacheHitRate) + '</span>', fmt.format(s.cacheHitTokens) + ' hit / ' + fmt.format(s.cacheMissTokens) + ' miss'),
        kpi('Input Tokens', fmt.format(s.inputTokens), 'DeepSeek prompt tokens'),
        kpi('Output Tokens', fmt.format(s.outputTokens), 'assistant + tool loop output'),
        kpi('Average Latency', ms(s.avgDurationMs), 'local bridge to upstream response'),
      ].join('');

      const prefix = data.prefix;
      const hitWidth = s.cacheHitRate == null ? 0 : Math.max(0, Math.min(100, s.cacheHitRate * 100));
      document.getElementById('cacheHealth').innerHTML =
        '<div class="stack"><span class="pill">Compared calls: ' + fmt.format(prefix.comparedCalls) + '</span><span class="pill good">Low risk: ' + fmt.format(prefix.lowRisk) + '</span><span class="pill warn">Medium: ' + fmt.format(prefix.mediumRisk) + '</span><span class="pill bad">High: ' + fmt.format(prefix.highRisk) + '</span></div>' +
        '<p class="subtle">Cache hit rate</p><div class="bar"><span style="width:' + hitWidth + '%"></span></div>' +
        '<p class="subtle">Average previous prompt covered: ' + pct(prefix.avgPreviousPromptCovered) + '</p>' +
        '<p class="subtle">System changes: ' + fmt.format(prefix.systemChanges) + ' · Tool changes: ' + fmt.format(prefix.toolChanges) + '</p>' +
        '<ul class="list">' + data.recommendations.map(item => '<li>' + item + '</li>').join('') + '</ul>';

      const command = data.config.logDir ? 'codex-deepseek-bridge cache-report --log-dir "' + data.config.logDir + '"' : 'DSCB_LOG_DIR="$HOME/.codex/codex-deepseek-bridge/logs" codex-deepseek-bridge serve';
      document.getElementById('setup').innerHTML =
        '<div class="stack"><span class="pill">API key: ' + (data.config.apiKeyConfigured ? 'configured' : 'missing') + '</span><span class="pill">Payload logs: ' + (data.config.logPayloads ? 'on' : 'off') + '</span><span class="pill">Vision: ' + (data.config.enableVision ? 'on' : 'off') + '</span></div>' +
        '<p class="subtle">Base URL: <code>' + data.config.deepseekBaseUrl + '</code></p>' +
        '<p class="subtle">Model: <code>' + data.config.modelAlias + '</code> -> <code>' + data.config.upstreamModel + '</code></p>' +
        '<p class="subtle">Log file: <code>' + text(data.logFile) + '</code> ' + (data.logFileExists ? '' : '(not created yet)') + '</p>' +
        '<pre>' + command + '</pre>';

      document.getElementById('models').innerHTML = table(['Model', 'Calls', 'Tokens', 'Cache', 'Avg latency'], data.models.map(m =>
        '<tr><td><code>' + m.model + '</code></td><td>' + fmt.format(m.calls) + '</td><td>' + fmt.format(m.inputTokens) + ' in / ' + fmt.format(m.outputTokens) + ' out</td><td><span class="' + cls(m.cacheHitRate) + '">' + pct(m.cacheHitRate) + '</span><br><span class="subtle">' + fmt.format(m.cacheHitTokens) + ' hit / ' + fmt.format(m.cacheMissTokens) + ' miss</span></td><td>' + ms(m.avgDurationMs) + '</td></tr>'
      ));

      document.getElementById('calls').innerHTML = table(['Time', 'Model', 'Status', 'Tokens', 'Cache', 'Prefix'], data.calls.map(c => {
        const prefix = c.prefix;
        return '<tr><td>' + text(c.time).replace('T', ' ').replace('Z', '') + '<br><span class="subtle">' + c.id + '</span></td><td><code>' + text(c.upstream?.model || c.request?.model) + '</code><br><span class="subtle">' + text(c.request?.reasoning?.effort) + ' · ' + text(c.upstream?.thinking?.type) + '</span></td><td><span class="' + (c.status === 'failed' ? 'bad' : 'good') + '">' + c.status + '</span><br><span class="subtle">' + ms(c.durationMs) + '</span></td><td>' + fmt.format(c.usage?.input_tokens || 0) + ' in<br>' + fmt.format(c.usage?.output_tokens || 0) + ' out</td><td><span class="' + cls(c.cache.hitRate) + '">' + pct(c.cache.hitRate) + '</span><br><span class="subtle">' + fmt.format(c.cache.hitTokens) + ' / ' + fmt.format(c.cache.missTokens) + '</span></td><td><span class="' + riskClass(prefix?.risk) + '">' + text(prefix?.risk) + '</span><br><span class="subtle">' + (prefix ? pct(prefix.previousPromptCovered) + ' previous covered, ' + prefix.commonPrefixMessages + ' msgs' : 'first comparable call') + '</span></td></tr>';
      }));
    }
    load().catch(error => {
      document.querySelector('main').innerHTML = '<div class="empty">Report failed to load: ' + error.message + '</div>';
    });
  </script>
</body>
</html>`;
}
