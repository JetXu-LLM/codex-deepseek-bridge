# Codex DeepSeek Bridge

Use DeepSeek models inside OpenAI Codex through a tiny local Responses-compatible bridge.

Codex speaks the OpenAI Responses API. DeepSeek currently exposes an OpenAI-compatible Chat Completions API. This project closes exactly that gap on `localhost`: it translates Codex `/v1/responses` calls into DeepSeek `/chat/completions`, then translates text, thinking, streaming events, tool calls, and usage metadata back into the shape Codex expects.

The goal is simple: make DeepSeek in Codex feel elegant, local, reversible, and observable.

## Why This Exists

Codex can be extended with custom providers and model catalogs, but a clean DeepSeek path needs more than pointing Codex at a Chat Completions endpoint. Codex uses Responses-style tool calls, streaming events, reasoning state, and model metadata. Codex DeepSeek Bridge provides that narrow compatibility layer without becoming a general LLM router.

This repo is for people who want:

- a focused Codex-to-DeepSeek bridge
- DeepSeek Pro, Flash, and no-thinking variants
- a Codex profile installer that does not break existing ChatGPT login
- an app-first path for users who only have a DeepSeek API key
- local token, cache, latency, and failure reports
- no project-owned backend, database, telemetry, or analytics

## Choose Your Mode

| User situation | Recommended mode | What happens |
| --- | --- | --- |
| You already use Codex with ChatGPT Free, Plus, Pro, Business, Enterprise, or OpenAI auth | **Profile Mode** | Keeps your existing login and GPT setup. DeepSeek is used only when you start Codex with the `deepseek` profile. |
| You do not have a ChatGPT/OpenAI Codex login, but you do have a DeepSeek API key | **App Login Mode** | Codex stores your DeepSeek key through its API-key login flow while this project points Codex at the local bridge. |
| You want the Codex app to route local sessions through DeepSeek by default | **App DeepSeek Mode** | Explicit, reversible activation. Current verified Codex builds may treat the custom model catalog as an override, so GPT models may be hidden until restore. |
| You only want to test the bridge from a terminal | CLI smoke test | Useful for verification and debugging, not the primary product experience. |

DeepSeek API keys are never Codex account credentials. In App Login Mode, Codex stores the key because Codex can store API-key login credentials; the local config makes Codex send that bearer token to `127.0.0.1`, where the bridge uses it as the DeepSeek upstream key.

## Install

Until the npm package is published, install from GitHub:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
```

From a local clone:

```bash
git clone https://github.com/JetXu-LLM/codex-deepseek-bridge.git
cd codex-deepseek-bridge
npm test
npm run check
npm link
```

After npm publication:

```bash
npm install -g codex-deepseek-bridge
```

Requirements:

- Node.js 18+
- Codex installed locally
- a DeepSeek API key for live DeepSeek calls

## Quick Start: Existing ChatGPT Or OpenAI Codex Login

Use Profile Mode. This is the safest default because it does not replace your current Codex login, default model, ChatGPT subscription access, or GPT model list.

```bash
codex-deepseek-bridge install --model deepseek-v4-pro
export DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve --daemon
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge doctor --live
codex --profile deepseek
```

Open the local report:

```bash
codex-deepseek-bridge open-report
```

Or visit:

```text
http://127.0.0.1:8787/report
```

Profile Mode creates:

- `~/.codex/deepseek.config.toml`
- `~/.codex/codex-deepseek-bridge/models.json`
- `~/.codex/codex-deepseek-bridge/install-state.json`

It does not change `~/.codex/config.toml` unless legacy compatibility is needed or you explicitly activate app mode.

## Quick Start: No ChatGPT Account, DeepSeek Key Only

Use App Login Mode. This is the app-first path for users who want to use the Codex app with a DeepSeek API key and no ChatGPT/OpenAI account.

macOS or Linux:

```bash
export DEEPSEEK_API_KEY="your_deepseek_api_key"
printf "%s\n" "$DEEPSEEK_API_KEY" | codex-deepseek-bridge app-login --from-stdin
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge open-report
```

Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY="your_deepseek_api_key"
$env:DEEPSEEK_API_KEY | codex-deepseek-bridge app-login --from-stdin
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge open-report
```

Then open or restart the Codex app.

What App Login Mode does:

- installs the local bridge model catalog
- activates a marked Codex config block that points Codex at `http://127.0.0.1:8787/v1`
- marks the provider with `requires_openai_auth = true`
- stores your DeepSeek key through Codex API-key login
- starts the local bridge daemon

What it does not do:

- create a ChatGPT account
- grant ChatGPT workspace or cloud features
- use OpenAI/ChatGPT plan credits
- send data to this project, a project server, or a project database

Undo App Login Mode:

```bash
codex-deepseek-bridge restore --logout
```

Then restart Codex. `--logout` matters because this mode intentionally stores a DeepSeek key in Codex's API-key login cache for the current `CODEX_HOME`.

## App Model Selector Reality

Current verified Codex builds treat `model_catalog_json` as a model catalog override, not a proven additive extension. That means this project should not promise that DeepSeek appears beside GPT models in the Codex app model picker at the same time.

The honest behavior today:

- Profile Mode keeps normal GPT models outside the `deepseek` profile.
- App Login Mode and App DeepSeek Mode can make Codex route local sessions through DeepSeek.
- While app mode is active, GPT models may be hidden until you restore the previous config.
- Restore is explicit and reversible with `codex-deepseek-bridge restore --logout`.

If a future Codex release supports additive custom model catalogs in the app picker, this project can adapt without changing its core bridge.

## Features

- Local `/v1/responses` bridge for Codex.
- `GET /v1/models`, `/health`, `/report`, and `/report/data`.
- Streaming Responses events.
- Function tools, namespace tools, and Codex custom freeform tools such as `apply_patch`.
- DeepSeek V4 Pro, V4 Flash, and no-thinking variants.
- DeepSeek thinking mode with Codex reasoning effort mapped to DeepSeek `high` or `max`.
- Multi-turn continuity by carrying DeepSeek `reasoning_content` through Codex reasoning state.
- Profile-first installer for existing ChatGPT/OpenAI users.
- App Login Mode for DeepSeek-key-only users.
- Reversible App DeepSeek Mode with backups.
- `doctor --auth`, `doctor --live`, `status`, `stop`, `restore`, and `open-report`.
- JSONL call logs with token and cache fields.
- `cache-report` for DeepSeek KV cache hit-rate summaries.
- Local HTML report with calls, tokens, cache hits, failures, and prompt-prefix diagnostics.
- Future-ready image input switch for DeepSeek multimodal APIs.
- Zero runtime dependencies.

## Models And Thinking Modes

Codex-facing models:

- `deepseek-v4-pro`
- `deepseek-v4-flash`
- `deepseek-v4-pro-no-thinking`
- `deepseek-v4-flash-no-thinking`

Reasoning mapping:

- Codex `High` -> DeepSeek thinking enabled with `reasoning_effort: "high"`
- Codex `Extra High`, `xhigh`, or `max` -> DeepSeek thinking enabled with `reasoning_effort: "max"`
- Codex `Low` or `Medium` -> DeepSeek thinking enabled with `reasoning_effort: "high"`
- `*-no-thinking` models -> DeepSeek `thinking.disabled`

Use Pro or Flash for thinking mode. Use a no-thinking model when you want thinking disabled, even if the Codex UI still shows a reasoning menu.

## Cache And Local Report

DeepSeek KV cache is automatic on the DeepSeek API side. The bridge does not replay outputs or run a semantic cache. It records cache usage when DeepSeek returns cache fields, then explains what happened locally.

The report shows:

- total calls and failures
- input, output, and total tokens
- DeepSeek cache hit and miss tokens
- cache hit rate by model
- recent request latency and status
- prompt-prefix continuity
- volatile prompt signals such as timestamps, temp paths, and UUIDs

Open it:

```bash
codex-deepseek-bridge open-report
```

Summarize cache behavior in the terminal:

```bash
codex-deepseek-bridge cache-report
```

Prompt text is not stored by default. The bridge stores hashes, lengths, role sequences, tool hashes, and usage metadata. Full payload logging is opt-in with `DSCB_LOG_PAYLOADS=1`.

The bridge does not rewrite Codex prompts by default. Cache optimization starts with evidence from the report; any future canonicalization should be opt-in, narrow, and tested.

## Configuration

Common environment variables:

- `DEEPSEEK_API_KEY`: DeepSeek API key used by Profile Mode and live tests.
- `DEEPSEEK_BASE_URL`: default `https://api.deepseek.com`.
- `DEEPSEEK_MODEL`: upstream DeepSeek model, default `deepseek-v4-pro`.
- `DEEPSEEK_THINKING`: `enabled`, `disabled`, or `none`; default `enabled`.
- `DEEPSEEK_ENABLE_VISION`: set `1` only after the selected DeepSeek model supports image input.
- `BRIDGE_MODEL`: optional Codex-facing custom model alias.
- `DSCB_LOG_DIR`: metadata log directory; set `off` to disable logs.
- `DSCB_LOG_PAYLOADS`: set `1` to log redacted payloads locally.
- `DSCB_BRIDGE_API_KEY`: optional local bearer token if you expose the bridge beyond localhost.

Generated files live under `CODEX_HOME`, which defaults to `~/.codex` on macOS/Linux and `%USERPROFILE%\.codex` on Windows.

## macOS

Profile Mode:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
export DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve --daemon
codex --profile deepseek
```

App Login Mode:

```bash
export DEEPSEEK_API_KEY="your_deepseek_api_key"
printf "%s\n" "$DEEPSEEK_API_KEY" | codex-deepseek-bridge app-login --from-stdin
```

Restore:

```bash
codex-deepseek-bridge restore --logout
```

## Windows PowerShell

Profile Mode:

```powershell
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
$env:DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve
codex --profile deepseek
```

App Login Mode:

```powershell
$env:DEEPSEEK_API_KEY="your_deepseek_api_key"
$env:DEEPSEEK_API_KEY | codex-deepseek-bridge app-login --from-stdin
```

Restore:

```powershell
codex-deepseek-bridge restore --logout
```

Native Windows Codex and WSL Codex can use different Codex homes. Install and run the bridge in the same environment where the Codex agent runs.

## Prompt To Give Codex

Paste this into Codex when you want Codex to install and verify the bridge for you:

```text
Install Codex DeepSeek Bridge for this machine.

Goal:
Use DeepSeek from Codex through a local Responses-compatible bridge without breaking my existing Codex setup.

First ask which mode I want:
1. Profile Mode if I already have ChatGPT/OpenAI Codex login and want to keep GPT sessions unchanged.
2. App Login Mode if I have no ChatGPT/OpenAI Codex login and want to use the Codex app with only a DeepSeek API key.

Steps for Profile Mode:
1. Check Node.js 18+, npm, Git, and Codex are available.
2. Install `codex-deepseek-bridge` from npm if available; otherwise install from `github:JetXu-LLM/codex-deepseek-bridge` or clone the repo.
3. Run `codex-deepseek-bridge install --model deepseek-v4-pro`.
4. Do not modify my global Codex default provider.
5. Start the bridge with `DEEPSEEK_API_KEY` in the bridge process.
6. Run `codex-deepseek-bridge doctor --auth`, `codex-deepseek-bridge doctor --live`, and a small `codex exec --profile deepseek` smoke test.
7. Open `http://127.0.0.1:8787/report` and confirm the report loads.

Steps for App Login Mode:
1. Explain that this mode is for DeepSeek-key-only app usage and may temporarily hide GPT models because current Codex builds can treat `model_catalog_json` as an override.
2. Use `codex-deepseek-bridge app-login --from-stdin` if I provide the key through stdin or an environment variable.
3. If no key is available in the shell, run `codex-deepseek-bridge app-login`, then guide me to choose API-key login in Codex app and paste my DeepSeek API key.
4. Confirm the bridge is running, open the local report, and run `doctor --auth`.
5. Tell me how to undo it with `codex-deepseek-bridge restore --logout`.

Important:
- Never commit, print, or log my API key.
- Keep public docs and committed files English-only.
- Treat App DeepSeek Mode as reversible routing, not guaranteed additive app model-picker support.
- If anything breaks, restore before making more changes.
```

## API Coverage

Implemented:

- `POST /v1/responses`
- `POST /responses`
- `GET /v1/models`
- `GET /models`
- `GET /health`
- `GET /report`
- `GET /report/data`

Not implemented:

- hosted OpenAI tools such as hosted web search
- remote files or vector stores
- provider-level team policy
- true image input until DeepSeek exposes multimodal API support

## Non-Goals

- multi-provider routing
- app UI injection
- cloud-hosted proxying
- team billing or policy management
- project-owned telemetry or analytics
- silent prompt rewriting

## Development

```bash
npm test
npm run check
npm pack --dry-run
```

Live smoke test:

```bash
export DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve
codex-deepseek-bridge doctor --live
```

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [Architecture](docs/architecture.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Cache and observability](docs/cache-and-observability.md)
- [Privacy and network model](docs/privacy-and-network.md)
- [Platforms and upgrades](docs/platforms-and-upgrades.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
