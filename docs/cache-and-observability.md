# Cache And Observability

Codex DeepSeek Bridge records local metadata so you can understand DeepSeek token usage, cache hits, cache misses, latency, model routing, and prompt-prefix stability.

## DeepSeek Context Caching

DeepSeek context caching is automatic on the API side. The bridge does not create a local semantic cache and does not replay model outputs. Instead, it records DeepSeek cache usage fields when present:

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- compatible cached-token fields returned through `prompt_tokens_details`

Use the local report:

```text
http://127.0.0.1:8787/report
```

Or use the CLI summary:

```bash
codex-deepseek-bridge cache-report
```

## What The Report Shows

The report is intentionally local and read-only. It shows:

- total calls, failed calls, and average upstream latency
- input/output token totals
- DeepSeek cache hit and miss tokens
- cache hit rate by model
- recent calls with model, thinking mode, duration, tokens, and cache fields
- prompt-prefix continuity between comparable requests
- volatile prompt signals such as timestamps, temp paths, and UUIDs

The report reads the same `calls.jsonl` metadata log as the CLI report.

## Prompt Privacy

By default, prompt diagnostics do not store prompt text. They store:

- message hashes
- content lengths
- role sequences
- system prompt hash
- tool schema hash
- stable prefix hash
- volatile-signal counts

Set `DSCB_LOG_PAYLOADS=1` only when you intentionally want redacted request and response payloads written to local disk for debugging.

## Prefix Stability

DeepSeek cache hits depend on stable, fully matching cached prefixes. The bridge compares each request with the previous comparable request in the same model and stable-prefix group.

The report classifies prefix risk as:

- `low`: system/tool prefix is stable and the previous prompt is mostly covered
- `medium`: the previous prompt is only partially covered
- `high`: system prompt, tool schema, or most of the previous prompt changed

High prefix risk does not mean the bridge is wrong. It means the next step is diagnosis: check whether Codex changed the thread context, model, tool set, system prompt, temporary paths, timestamps, or other volatile data.

## Prompt Rewriting

The bridge does not rewrite prompts by default. It preserves Codex message order and reports prefix stability so you can diagnose cache behavior without changing agent behavior.
