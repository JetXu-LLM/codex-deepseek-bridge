# Contributing

Thanks for helping improve Codex DeepSeek Bridge.

This project is intentionally small. Contributions should strengthen the Codex-to-DeepSeek path without turning the bridge into a general router.

## Development Setup

Requirements:

- Node.js 18+
- npm
- Codex CLI for live verification

Run the local checks:

```bash
npm test
npm run check
```

Run a live smoke test:

```bash
export DEEPSEEK_API_KEY="your_test_key"
codex-deepseek-bridge serve
codex-deepseek-bridge doctor --live
```

## Pull Request Checklist

- Keep changes scoped to Codex + DeepSeek.
- Add or update tests for protocol translation, logging, reports, or install behavior.
- Do not commit API keys, local logs, user transcripts, or generated `~/.codex` files.
- Keep prompt payload logging opt-in.
- Keep prompt rewriting opt-in and guarded by tests.
- Run `npm test` and `npm run check`.
- Update README or docs when behavior changes.

## Design Constraints

- Prefer zero runtime dependencies.
- Prefer local, inspectable behavior over cloud services.
- Keep install reversible.
- Keep profile mode safe by default.
- Do not change the user's global Codex provider unless a command explicitly asks for activation.
- Treat `install --activate` as reversible App DeepSeek Mode. Do not describe it as additive Codex app model-picker support unless verified on the current Codex build.
- Keep App Login Mode usable for users who have a DeepSeek API key but no ChatGPT/OpenAI Codex login.
- Make App Login Mode easy to restore with `restore --logout`.
- Treat cache optimization as evidence-driven: report first, rewrite only with a narrow tested rule.

## Release Checklist

Before publishing:

```bash
npm test
npm run check
npm pack --dry-run
```

Confirm:

- package contents are small and intentional
- README quick start still works
- `/report` and `/report/data` load from a local bridge
- no secrets are present in the repository
