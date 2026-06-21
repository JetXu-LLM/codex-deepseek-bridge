# Cache And Observability

The bridge records local metadata so you can understand DeepSeek token usage, cache hits and misses,
latency, model routing, and prompt-prefix stability. It is read-only and local. Prompt text is not
stored.

## DeepSeek context caching

DeepSeek context caching is automatic on the API side. The bridge does not create its own cache and
does not replay model outputs. It records the cache usage fields DeepSeek returns:

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- compatible cached-token fields from `prompt_tokens_details`

## The local report

The report is served by the same process as the bridge:

```
http://localhost:8787/report
```

It shows:

- total calls, failed calls, and average upstream latency
- input and output token totals
- DeepSeek cache hit and miss tokens, and hit rate by model
- recent calls with model, reasoning effort, duration, tokens, and cache fields
- prompt-prefix continuity between comparable requests
- volatile prompt signals such as timestamps, temp paths, and UUIDs

`GET /report/data` returns the same data as JSON, including the running bridge version.

## Prompt privacy

By default the diagnostics store no prompt text. They store:

- message hashes
- content lengths
- role sequences
- system-prompt hash
- tool-schema hash
- stable-prefix hash
- volatile-signal counts

Set `DSCB_LOG_PAYLOADS=1` only when you intentionally want redacted request and response payloads
written to local disk for debugging.

## Logs

Metadata logs default to `<bridgeHome>/logs/calls.jsonl` (`<bridgeHome>` is
`<CODEX_HOME>/codex-deepseek-bridge`). Disable them with `DSCB_LOG_DIR=off`.

## Prefix stability

DeepSeek cache hits depend on a stable, fully matching prefix. The bridge compares each request with
the previous comparable request and classifies prefix risk as `low`, `medium`, or `high`. High risk
is not a bug; it is a signal to check whether the model, tool set, system prompt, or volatile values
changed between turns.

## No prompt rewriting

The bridge preserves Codex message order and does not rewrite prompts. It reports prefix stability so
you can diagnose cache behavior without changing how the agent behaves.
