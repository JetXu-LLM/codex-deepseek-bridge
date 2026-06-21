# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning after `1.0.0`. Before `1.0.0`, minor versions may include
breaking changes.

## 0.1.12

Tightens restore semantics after the direct setup flow.

### Changed

- `restore` now also stops the bridge background process for the active bridge home. It still keeps
  the stored DeepSeek key unless the user explicitly runs `restore --logout`.

## 0.1.11

Polishes the Windows/Desktop-patch release and the direct user setup path.

### Added

- `report` now starts the local bridge when needed and opens the local report page in the browser.
- Added regression coverage for running config-only `setup` first, then re-running
  `setup --desktop-patch`; the catalog upgrades from `deepseek-pro` to
  `deepseek-pro` + `deepseek-flash` without duplicating the managed config block.

### Fixed

- macOS Desktop signing/restore tests now force the macOS patch path when they run on non-macOS CI
  workers. This keeps the Windows release job focused on the Windows-specific tests and lets the
  `codex-deepseek-bridge-win-x64.exe` asset build normally.

### Changed

- Plain `setup` no longer prompts to patch Codex Desktop app files. The Desktop picker patch now
  requires explicit opt-in with `setup --desktop-patch` or `DSCB_DESKTOP_PATCH=on`.
- README now leads with direct macOS and Windows download-and-run commands, documents the upstream
  Codex Desktop custom-model issues, and explains config-only versus Desktop-patched behavior.
- User-facing report URLs now prefer `localhost`; the bridge still binds to `127.0.0.1`.

## 0.1.10

Adds a safer Desktop patch rollout model and Windows picker-patch support.

### Added

- `setup --desktop-patch` now supports Windows Electron installs by backing up and patching
  `resources/app.asar`.
- Windows Store installs are mirrored into a managed writable copy under
  `<bridgeHome>/desktop-patch/windows-store-apps/`; setup prints a `Codex-DeepSeek.cmd` launcher for
  that patched copy.
- `restore` now removes Windows managed Desktop copies and launchers in addition to restoring
  writable Windows app bundles.

### Changed

- Config-only setup now publishes only `deepseek-pro`. `deepseek-flash` is published only when the
  Desktop picker patch is active.
- The running `/v1/models` endpoint follows the same active catalog so config-only mode exposes only
  `deepseek-pro`.
- README now leads with direct setup commands instead of the old paste-a-prompt flow, and documents
  the Codex Desktop picker issue tracked in openai/codex#19694.

### Security

- Public docs now state clearly that `--desktop-patch` modifies local Codex Desktop app files, that
  this project does not distribute a modified Codex app, and that users should review their own
  legal, workplace, and contract obligations before opting in.

## 0.1.9

Makes provider selection history-aware while avoiding reserved provider overrides.

### Fixed

- `setup` now chooses the bridge provider from the user's original config and local history database.
  Non-reserved providers such as `codex` are reused so Codex Desktop can keep showing matching local
  chat history.
- When history is under the reserved built-in `openai` provider, `setup` now uses the official
  `openai_base_url` override instead of writing `[model_providers.openai]`.
- Reserved non-OpenAI providers such as `ollama`, `lmstudio`, and `amazon-bedrock` fall back to the
  independent `deepseek_bridge` provider instead of being overridden.

### Changed

- CLI and docs now report whether setup preserved provider-scoped local history or used an
  independent provider whose hidden history returns after `restore`.

## 0.1.8

Fixes local API-key/GPT history disappearing after switching Codex to DeepSeek.

### Fixed

- The managed config now reuses Codex's local `codex` provider id while pointing that provider at
  the local bridge. Codex Desktop scopes local thread history by provider id, so existing local
  API-key/GPT history remains visible after setup.
- Re-running `setup` removes the active `[model_providers.codex]` table before writing the managed
  replacement, preventing duplicate TOML tables while keeping restore fully reversible from the
  original setup backup.

### Changed

- README, architecture docs, examples, and troubleshooting now distinguish local API-key history
  from ChatGPT cloud-only history.

## 0.1.7

Fixes the current macOS Codex Desktop picker filter for custom catalog models.

### Fixed

- `setup` now detects the Codex Desktop renderer allowlist gate that can hide `deepseek-pro` and
  `deepseek-flash` even when the app-server returns the bridge catalog correctly.
- On macOS, `setup` offers a reversible local picker patch only when that exact Desktop bundle shape
  is found. It requires confirmation, `setup --desktop-patch`, or `DSCB_DESKTOP_PATCH=on`, then backs
  up `app.asar`, `Info.plist`, `_CodeSignature`, and the root executable, updates Electron's ASAR
  integrity hash, and re-signs the app.
- `restore` now also restores the Codex Desktop picker patch, so a normal restore returns both
  `config.toml` and the local app bundle to the previous state.
- `restore` verifies the restored macOS app bundle and performs a local root-bundle re-sign if an
  older patch state cannot restore a valid signature directly.
- `doctor` reports the Desktop picker patch state alongside bridge, key, config, and login status.

### Changed

- Docs now distinguish the Desktop picker allowlist issue from the separate API-key login limitation
  that prevents ChatGPT-backed history from showing.
- Public metadata now uses Apache-2.0.

## 0.1.6

Keeps install and upgrade instructions accurate before the npm registry package is published.

### Fixed

- README and platform docs now use the working GitHub npm install command:
  `npm install -g github:JetXu-LLM/codex-deepseek-bridge`.
- `upgrade` in npm install mode now uses the GitHub install source instead of the not-yet-published
  npm registry package.

## 0.1.5

Fixes the Codex desktop picker and preserves ChatGPT-backed history.

### Fixed

- `models.json` now includes the desktop app-facing model fields (`model`, `displayName`,
  `defaultReasoningEffort`, and `supportedReasoningEfforts`) alongside the Codex CLI catalog fields.
  This fixes the picker showing `Custom` with an empty model submenu even though `codex debug models`
  accepted the catalog.
- `deepseek-pro` is now the stable desktop default after Codex app-server model sorting.
- The managed provider no longer requires Codex/OpenAI auth. The bridge uses the locally stored
  DeepSeek key, so ChatGPT sign-in can stay in place and Codex history can remain available.

### Changed

- Setup and docs now say to preserve the Codex login. API-key login mode is documented as a legacy
  state that cannot show ChatGPT-backed history.
- `setup` can reuse an existing stored DeepSeek key after a normal `restore`; `restore --logout`
  still removes the stored key for a full cleanup.

## 0.1.4

Fixes the macOS x64 release runner.

### Fixed

- The release workflow now builds the Intel macOS asset on `macos-15-intel`, the current standard
  GitHub-hosted Intel macOS runner label.

## 0.1.3

Fixes the release workflow on Windows.

### Fixed

- `npm run check` now uses a Node script instead of shell globs, so GitHub Actions can run the same
  syntax check on macOS and Windows.

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
