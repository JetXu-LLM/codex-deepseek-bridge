# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning after `1.0.0`. Before `1.0.0`, minor versions may include
breaking changes.

## 0.1.21

Completes MCP/plugin tool routing and makes binary upgrades visibly download.

### Fixed

- Namespace MCP and plugin tool calls now return to Codex as the leaf tool name plus its Codex
  namespace, matching successful native Codex calls such as `name: "js"` with
  `namespace: "mcp__node_repl"`. This fixes the remaining `unsupported call` failures after `0.1.20`.
- Streaming and non-streaming tool-call paths now both preserve that namespace.
- Follow-up tool-loop requests use Codex's returned `namespace + name` pair to recover the unique
  DeepSeek-facing safe tool name, including ambiguous leaf names such as `search`.

### Changed

- Guided binary upgrades now show simple download progress instead of sitting silently on slow
  networks.

## 0.1.20

Fixes MCP/plugin execution in Codex and makes setup harder to run against an old background bridge.

### Fixed

- Namespace MCP and plugin tools are sent to DeepSeek with unique safe names, repaired when DeepSeek
  returns a close-but-wrong name, then returned to Codex with the leaf tool name Codex expects. This
  avoids `unsupported call` failures such as returning `mcp__computer_use__list_apps` where Codex
  expects `list_apps`.
- `setup`, `restore`, `upgrade`, and `stop` now stop stale bridge `serve` processes even when the pid
  file is missing or points at an older run.

### Changed

- `setup` now explains an available update in the same structured style as the setup summary, then
  asks whether to upgrade first and continue setup.
- Config-only setup output now tells users to pick `Custom`, which routes to `deepseek-pro`; the
  named `deepseek-pro` / `deepseek-flash` picker entries are only promised after the Desktop patch.
- `restore` now prints a structured summary showing Codex config, Desktop patch, login, bridge
  process, key, and retained report data.

## 0.1.19

Makes future setup runs notice new releases before changing Codex.

### Added

- `setup` and `setup --desktop-patch` now check the latest GitHub release first. On an interactive
  terminal they ask `Upgrade before setup? [Y/n]`; after a verified binary upgrade, setup continues
  with the same arguments.
- The local report shows a small update notice from the bridge's cached release check and points
  users back to `setup` for the guided upgrade flow.

### Changed

- Binary upgrades keep the existing bridge home, stored key, logs, and report data. They only replace
  the bridge executable and then rerun the requested setup flow.

## 0.1.18

Fixes DeepSeek tool-call name drift and makes the local report useful for request-level debugging.

### Added

- The report now links each call to redacted raw Codex request, DeepSeek request, DeepSeek response,
  and Codex response JSON. Payload logging is on by default and can be disabled with
  `DSCB_LOG_PAYLOADS=0` or `--no-log-payloads`.

### Fixed

- DeepSeek-returned tool names are repaired when they uniquely match a known Codex plugin or MCP
  tool. This covers common namespace separator loss such as `mcp__computer_uselist_apps`, plus
  high-confidence typos, while leaving ambiguous names unchanged.

### Changed

- Setup output and README history notes now make provider-scoped local history clearer.
- The README now calls out plugin tool-name repair and the report's role in cache analysis, without
  changing the setup flow.

## 0.1.17

Fixes macOS restore behavior around the Desktop patch and makes the opt-in boundary clearer.

### Fixed

- `restore` no longer ad-hoc re-signs Codex.app when Apple's original signature cannot be verified.
  It now reports the recovery state clearly so Keychain prompts are not hidden behind another local
  signature.
- `restore --purge` keeps bridge backups when Desktop restore still needs them.
- Plain `setup` remains config-only and does not patch or re-sign Codex.app.

### Changed

- The README now calls out that `--desktop-patch` is an explicit user choice that modifies the
  locally installed Codex app bundle and signature.

## 0.1.16

Clearer setup output and honest macOS Desktop-patch guidance, plus a refreshed README.

### Added

- `setup` now prints a structured summary with labeled sections and, when the Desktop patch needs
  attention, a highlighted callout instead of a wall of text. Output is color-formatted on a TTY and
  stays plain ASCII when piped or redirected (`NO_COLOR` and `DSCB_NO_COLOR` are honored).

### Changed

- When `--desktop-patch` cannot modify Codex on macOS, the message now explains it is almost always
  macOS App Management (System Settings &rarr; Privacy & Security &rarr; App Management), notes that
  `sudo` does not help, and points to config-only `deepseek-pro` as the no-patch path.
- `doctor` surfaces the ad-hoc signature and Keychain-prompt situation whenever Codex is locally
  signed, with the fix (reinstall or update Codex), not only when the patch is unmanaged.
- Rebuilt the README with a clearer hero, value highlights, an embedded report screenshot, and an
  honest, prominent write-up of the opt-in Desktop patch and its macOS trade-offs. Expanded
  troubleshooting for the "not writable" and double Keychain-prompt cases.

## 0.1.15

Redesigns the local report and hardens Desktop patch error handling.

### Added

- A redesigned local report at `http://localhost:8787/report`: a single-page dashboard with KPI
  cards, inline SVG charts (cache hit rate, prefix risk, tokens by model, latency trend), a models
  table, and a recent-calls table where each row expands to full per-call metadata. It stays
  read-only and offline, stores no prompt text, and follows the system light or dark theme.

### Fixed

- `setup --desktop-patch` and `restore` no longer surface a raw Node stack trace when the Codex
  Desktop app is read-only. The failure is reported as a clear, actionable message.
- The report no longer shows confusing field values; the DeepSeek key status reads "Stored" or
  "Not stored".

### Changed

- Tightened the README and docs for clarity and consistency.

## 0.1.14

Fixes the macOS test regressions and makes Desktop patching more honest.

### Added

- `restore --purge` restores Codex, stops the bridge, and then removes bridge state, the stored
  DeepSeek key, logs, and Desktop compatibility patch backups.
- The Desktop compatibility patch now also relaxes known recent-thread provider filters so local
  history stays visible across compatible provider switches.

### Fixed

- `setup` now checks for an existing stored DeepSeek key before prompting. A normal `restore` keeps
  the key, so re-running `setup` no longer asks for it again unless a new key is supplied through
  `--from-stdin` or `DEEPSEEK_API_KEY`.
- MCP and plugin namespace tool names now keep Codex's double-underscore separator. Older builds
  could return names such as `mcp__node_repljs`, which Codex rejected as `unsupported call`.
- Desktop compatibility patch failures now report a readable error even when the attempted automatic
  restore is also blocked by OS permissions.

### Changed

- New setups default `model_reasoning_effort` and catalog defaults to `xhigh`, which maps to
  DeepSeek `reasoning_effort=max`.
- Quick Start now uses config-only `setup` by default. `setup --desktop-patch` remains an explicit
  opt-in because it modifies local Codex Desktop app files.
- The Apple Silicon binary asset is now `codex-deepseek-bridge-macos`; the Intel macOS asset remains
  `codex-deepseek-bridge-macos-x64`.

## 0.1.13

Keeps repeat setup runs on the expected local port.

### Changed

- `setup` now stops any already tracked bridge background process before resolving the port and
  starting a fresh bridge. This avoids stale local bridge processes forcing a new setup onto
  `8788+`.

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

- Plain `setup` no longer prompts to patch Codex Desktop app files. The Desktop compatibility patch now
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
  Desktop compatibility patch is active.
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
- `restore` now also restores the Codex Desktop compatibility patch, so a normal restore returns both
  `config.toml` and the local app bundle to the previous state.
- `restore` verifies the restored macOS app bundle and performs a local root-bundle re-sign if an
  older patch state cannot restore a valid signature directly.
- `doctor` reports the Desktop compatibility patch state alongside bridge, key, config, and login
  status.

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
