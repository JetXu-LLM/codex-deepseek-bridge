# AGENTS.md

Guidance for AI agents working in this repository.

## What this project is

Codex DeepSeek Bridge turns the OpenAI Codex app into a DeepSeek-only coding agent through a tiny
local Responses-compatible bridge. There is one path: run `setup`, restart Codex, and the model
picker shows exactly `deepseek-pro` and `deepseek-flash`. A single `restore` undoes everything.

Scope is macOS and Windows. There is no multi-provider routing, no GPT coexistence, no Codex UI
injection, and no telemetry.

## Hard rules

- The DeepSeek key is a secret. Read it from `--from-stdin` or `DEEPSEEK_API_KEY` only — never as a
  command-line argument. Never print, log, commit, or place it in a Codex prompt or session log.
  Store it at `<bridgeHome>/deepseek-key` with owner-only permissions.
- Write one managed `config.toml` block, after backing up any existing file. `setup` is idempotent
  (no duplicate blocks; key and port preserved on re-run).
- Login is detect-and-adapt: `codex login status` first, `auth.json` as a fallback, `uncertain` when
  unsure. Auto sign-in (`codex login --with-api-key`) only when no auth is detected. Never call
  `codex logout` implicitly.
- Two Codex-facing slugs (`deepseek-pro`, `deepseek-flash`) mapping to configurable upstream models
  (`DEEPSEEK_MODEL_PRO` / `DEEPSEEK_MODEL_FLASH`). Three reasoning efforts: `none | high | xhigh`,
  default `high`.
- Zero runtime dependencies. ESM. ASCII. English-only public docs.

## Conventions

- Modules live in `src/`; the CLI is `bin/codex-deepseek-bridge.mjs`.
- Tests use `node --test` against temporary `CODEX_HOME` / `DSCB_HOME` directories.
- Use `npm test` and `npm run check` before finishing a change.
- The self-contained binary is built by `npm run build:binary` (Node SEA). CI builds it on official
  Node; locally set `NODE_SEA_BASE` to an official node binary.

## User-facing copy

Lead with what the user gets, then how. Short sentences, plain words, no hype. Never print the user's
key. Keep the README and CLI messages aligned with the project voice.
