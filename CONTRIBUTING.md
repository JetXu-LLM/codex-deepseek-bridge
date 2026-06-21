# Contributing

Thanks for helping improve Codex DeepSeek Bridge.

This project is intentionally small: one DeepSeek-only path for the Codex app, fully reversible. Keep
contributions scoped to that bridge: it is not a multi-provider router or a Codex UI mod.

## Development setup

Requirements:

- Node.js 18+
- npm
- The Codex app or CLI for live verification

Run the local checks:

```bash
npm test
npm run check
```

Run a live smoke test against a temporary Codex home so your real config is untouched:

```bash
export CODEX_HOME="$(mktemp -d)"
printf '%s\n' 'YOUR_TEST_KEY' | node ./bin/codex-deepseek-bridge.mjs setup --from-stdin
node ./bin/codex-deepseek-bridge.mjs doctor --live
```

## Building the self-contained binary

The binary uses the Node Single Executable Application (SEA) feature. CI builds it on official Node
from `actions/setup-node`. Locally, point `NODE_SEA_BASE` at an official, statically-linked node (a
Homebrew node will not work — its shared `libnode` lacks the SEA fuse):

```bash
NODE_SEA_BASE=/path/to/official/node npm run build:binary
```

## Pull request checklist

- Keep changes scoped to Codex + DeepSeek.
- Add or update tests for translation, config, CLI, report, or upgrade behavior.
- Never commit API keys, local logs, transcripts, or generated `~/.codex` files.
- Keep payload logging and any prompt canonicalization opt-in and tested.
- Run `npm test` and `npm run check`.
- Update the README or docs when behavior changes.

## Design constraints

- Zero runtime dependencies for the bridge. ESM. ASCII. English-only public docs.
- macOS and Windows only.
- The DeepSeek key is a secret: stdin or `DEEPSEEK_API_KEY` only; never an argument, prompt, log, or
  commit.
- One managed `config.toml` block, written after a backup. `setup` is idempotent.
- Login is detect-and-adapt: `codex login status` first, `auth.json` as a fallback. Never call
  `codex logout` implicitly.
- Keep `restore` a clean, reversible undo.
- Cache work is evidence-driven: report first, rewrite only with a narrow, tested rule.

## Release checklist

```bash
npm test
npm run check
npm pack --dry-run
```

Confirm package contents are small and intentional, `/report` and `/report/data` load from a local
bridge, and no secrets are present in the repository. npm publishing is manual and gated.
