# Troubleshooting

## Codex says `/responses` is missing

Codex is not reaching the bridge, or the provider base URL is wrong. The Codex provider should point at:

```toml
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

Run:

```bash
codex-deepseek-bridge status
curl http://127.0.0.1:8787/health
```

## `codex --profile deepseek` says the profile is missing

You are likely on a Codex CLI older than `0.134`, which reads profiles from `~/.codex/config.toml` instead of separate `~/.codex/*.config.toml` files. Re-run:

```bash
codex-deepseek-bridge install --legacy-profile
```

The installer auto-detects this for known older CLI versions, but the flag is available when Codex is not on `PATH` during install.

## DeepSeek key works in curl but not in Codex app

In Profile Mode, the Codex app may not inherit shell environment variables. Start the bridge from a terminal where `DEEPSEEK_API_KEY` is available, or use an OS secret loader that exports it before starting the bridge.

In App Login Mode, the bridge can use the bearer token sent by Codex as the DeepSeek key. Run:

```bash
codex-deepseek-bridge doctor --auth
```

If App Login Mode is active but Codex is still signed in with ChatGPT, switch this Codex home to API-key login with your DeepSeek key or restore and use Profile Mode instead.

## GPT models disappeared from the selector

If you used `install --activate`, Codex may now be in App DeepSeek Mode. Current verified Codex builds can treat `model_catalog_json` as an override, so the normal GPT model catalog may be hidden until you restore the previous config.

Run:

```bash
codex-deepseek-bridge restore
```

If you used App Login Mode, run `codex-deepseek-bridge restore --logout` instead. Then restart Codex.

You can also manually remove the managed block between:

```toml
# >>> codex-deepseek-bridge
# <<< codex-deepseek-bridge
```

The installer writes a backup before activation when a config file already exists.

## DeepSeek works in CLI but does not appear in the Codex app model selector

Current Codex app builds can be stricter than the CLI about which custom model catalog entries they show. First verify routing:

```bash
codex-deepseek-bridge status
codex-deepseek-bridge doctor --live
codex --profile deepseek
```

If those work, the bridge and profile are healthy. Run `codex-deepseek-bridge install --activate` only if you want the app's default local provider to route through DeepSeek, then restart the Codex app. Treat this as App DeepSeek Mode, not guaranteed additive model-picker support. If the visual picker still shows only GPT models, use Profile Mode or App Login Mode depending on your auth situation. If GPT models disappear unexpectedly, run `codex-deepseek-bridge restore` and restart Codex; if App Login Mode stored a DeepSeek key in Codex auth, run `codex-deepseek-bridge restore --logout`.

## I signed in with ChatGPT Plus. Did this replace my login?

No. Profile mode writes a separate `~/.codex/deepseek.config.toml` and leaves your ChatGPT login cache untouched. DeepSeek calls use `DEEPSEEK_API_KEY` in the bridge process. OpenAI-hosted Codex features that require ChatGPT workspace access still depend on your existing Codex sign-in.

Do not use App Login Mode unless you intentionally want to switch this Codex home into DeepSeek-key app routing. App Login Mode can replace the active API-key login credential for that Codex home. Restore it with:

```bash
codex-deepseek-bridge restore --logout
```

## Can I use this without a ChatGPT or OpenAI Codex login?

Yes, use App Login Mode. It is the app-first path for DeepSeek-key-only users.

Use:

```bash
printf "%s\n" "your_deepseek_api_key" | codex-deepseek-bridge app-login --from-stdin
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge open-report
```

Then open or restart the Codex app. Codex stores the DeepSeek key through API-key login while App Login Mode points the active provider at localhost.

Undo it:

```bash
codex-deepseek-bridge restore --logout
```

Codex cloud, remote plugin sync, and workspace features can still require ChatGPT/OpenAI authentication. App Login Mode gives Codex a local DeepSeek model path; it does not create a ChatGPT account.

Run:

```bash
codex-deepseek-bridge doctor --auth
```

This prints local profile, catalog, managed-block, and auth-file diagnostics without showing secrets.

## How do I choose Pro, Flash, and thinking mode?

Use one of these Codex-facing models:

```text
deepseek-v4-pro
deepseek-v4-flash
deepseek-v4-pro-no-thinking
deepseek-v4-flash-no-thinking
```

For the thinking models, Codex `High` maps to DeepSeek `high`, and Codex `Extra High` / `xhigh` / `max` maps to DeepSeek `max`. Choose a `no-thinking` model variant when you want `thinking.disabled`; the Codex reasoning menu may still be visible, but the bridge ignores it for those variants.

## Windows and WSL use different Codex homes

Native Windows Codex reads `%USERPROFILE%\.codex`. Codex inside WSL reads Linux `~/.codex` unless you set `CODEX_HOME`. Install and run the bridge in the same environment where the Codex agent runs, or explicitly point WSL to the Windows Codex home:

```bash
export CODEX_HOME=/mnt/c/Users/YOUR_NAME/.codex
```

## Tool calls loop or fail

Open the local report:

```text
http://127.0.0.1:8787/report
```

The report shows recent calls, upstream status, token usage, cache hit/miss fields, and prompt-prefix stability. Metadata logging is enabled by default at `~/.codex/codex-deepseek-bridge/logs`.

If you disabled logs, turn them back on:

```bash
export DSCB_LOG_DIR="$HOME/.codex/codex-deepseek-bridge/logs"
codex-deepseek-bridge serve
```

Inspect `calls.jsonl` for tool names, upstream status, usage, cache fields, and prompt-prefix hashes. Set `DSCB_LOG_PAYLOADS=1` only when you are comfortable logging redacted payloads locally.

## Cache hit rate is worse than expected

DeepSeek cache hits require stable, fully matching cached prefixes. Use `/report` first:

- If system or tool hashes change often, keep the same model, reasoning mode, tool set, and `AGENTS.md` instructions stable.
- If previous-prompt coverage is high but cache hits are low, the miss is likely normal first-use behavior, cache expiry, or upstream best-effort behavior.
- If volatile signals appear, check whether timestamps, temp paths, UUIDs, or other changing values are entering the prompt.

Do not enable prompt rewriting as a first reaction. Rewriting can improve cache in narrow cases, but it can also change Codex behavior. Prefer diagnosis first, then add a tested canonicalization rule.

## Image input is omitted

DeepSeek currently does not expose the assumed multimodal API in this bridge. Set `DEEPSEEK_ENABLE_VISION=1` only after DeepSeek's API supports image input for the selected model.
