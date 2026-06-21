# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning after `1.0.0`. Before `1.0.0`, minor versions may include
breaking changes.

## 0.1.2

Fixes the model catalog for current Codex builds.

### Fixed

- `models.json` now uses Codex's current reasoning catalog fields:
  `default_reasoning_level` and `supported_reasoning_levels`. Older bridge builds wrote the previous
  field names, so `codex debug models` rejected the catalog and the app kept showing GPT models.
- Added regression coverage that rejects the old field names and verifies the three visible
  reasoning levels: `none`, `high`, and `xhigh`.

### Changed

- Install docs now recommend interactive `setup`, where the terminal asks for the DeepSeek key
  without echoing it. `--from-stdin` remains supported for automation.

## 0.1.1

Fixes a config-writing bug that could corrupt `~/.codex/config.toml`.

### Fixed

- The managed block no longer reparents your existing root-level settings under the DeepSeek provider
  table. TOML treats every bare key after a `[table]` header as part of that table, so appending user
  content after the managed block's `[model_providers.deepseek_bridge]` table moved root keys (e.g.
  `sandbox_mode`, `approval_policy`, `notify`) under it and made `config.toml` invalid — which made
  Codex fall back to defaults (GPT picker, empty project list). The writer now keeps all root keys
  before any table and places the provider table after them, so the config stays valid TOML and Codex
  keeps reading your projects and settings.
- `setup` now strips only the root keys the managed block actually writes (`model`, `model_provider`,
  `model_catalog_json`, `model_reasoning_effort`), preserving every other user setting.

## 0.1.0

A single, DeepSeek-only Codex experience. This is a redesign: Codex runs on DeepSeek through one
managed config, fully reversible.

### Added

- One-command `setup`: writes the two-model catalog and a single managed `config.toml` block (after a
  backup), stores the DeepSeek key with owner-only permissions, adapts Codex login, and starts the
  background bridge.
- Exactly two Codex-facing models, `deepseek-pro` and `deepseek-flash`, mapping to configurable
  upstream models (`DEEPSEEK_MODEL_PRO` / `DEEPSEEK_MODEL_FLASH`).
- Three reasoning efforts per model — `none | high | xhigh` (default `high`) — mapped to DeepSeek
  thinking controls.
- Login detect-and-adapt: auto sign-in with the DeepSeek key when not signed in; guidance (never an
  automatic change) when signed in with ChatGPT or when the state is uncertain.
- A simplified CLI: `setup`, `start`, `report`, `doctor [--live]`, `restore [--logout]`,
  `upgrade [--check]`, `version`, `status`, `stop`.
- Local Responses-compatible bridge with streaming, function/namespace/freeform tools, reasoning
  continuity, and DeepSeek cache usage mapping.
- Local HTML report at `/report` and JSON at `/report/data`; metadata logs that never store prompt
  text by default.
- Upgrade groundwork: version on `/health`, an install-state schema with the install method, an
  idempotent `setup` reconcile, and an opt-out, privacy-preserving update check
  (`DSCB_UPDATE_CHECK=off` / `DO_NOT_TRACK=1`).
- A self-contained binary for macOS (arm64/x64) and Windows (x64) built with Node SEA, with published
  checksums and a tagged release workflow.

### Changed

- Replaced the previous Profile / App Login / App DeepSeek modes with the single DeepSeek-only path.

### Removed

- Profile, app-login, and legacy-profile commands and config generation.
- The no-thinking model variants (folded into the `none` reasoning effort).
- WSL and Linux guidance; the project targets macOS and Windows.
