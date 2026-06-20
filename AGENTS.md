# AGENTS.md

This repo has one job: make OpenAI Codex work with DeepSeek through a small local Responses-compatible bridge.

## Scope

- Keep the bridge focused on Codex and DeepSeek.
- Do not turn this into a general LLM router.
- Prefer zero runtime dependencies unless a dependency removes real protocol risk.
- Keep code readable for users who want to audit how prompts, tool calls, and keys move.

## Safety

- Never commit real API keys, bearer tokens, request logs, or user transcripts.
- Redact secrets in logs and errors.
- Do not modify a user's `~/.codex/config.toml` unless a command explicitly asks for activation.
- Keep `install` profile-first and reversible.
- Keep App Login Mode explicit: it stores a DeepSeek key through Codex API-key auth for the current Codex home.
- Use `restore --logout` as the clean rollback path for App Login Mode.
- Treat `install --activate` as reversible App DeepSeek Mode, not guaranteed additive app model-picker support.
- Do not claim DeepSeek appears beside GPT models in the Codex app unless verified against the current Codex build.
- Keep prompt text out of metadata logs by default. Prompt payload logging must stay opt-in through `DSCB_LOG_PAYLOADS=1`.

## Cache And Reports

- `/report` and `cache-report` should explain DeepSeek usage; they should not become a general analytics product.
- Cache optimization must be evidence-driven. Diagnose prefix drift before changing prompts.
- Do not enable prompt rewriting by default.
- Preserve Codex message order unless a protocol requirement proves otherwise.

## Verification

Before shipping a change:

```bash
npm test
npm run check
```

For live verification, use a throwaway key or user-provided key:

```bash
DEEPSEEK_API_KEY="..." codex-deepseek-bridge serve
codex-deepseek-bridge doctor --live
```

## Style

- Use modern Node.js ESM.
- Keep files ASCII unless a referenced protocol or document requires otherwise.
- Prefer small modules over a monolithic bridge file.
- Add comments only where protocol translation would otherwise be hard to follow.
- Public repo docs are English only.
