# Changelog

All notable changes to this project will be documented here.

This project follows semantic versioning after `1.0.0`. Before `1.0.0`, minor versions may include breaking changes.

## 0.1.0

Initial public-ready bridge foundation.

### Added

- Local Responses-compatible bridge for Codex.
- DeepSeek Chat Completions upstream adapter.
- Streaming Responses events.
- Function tools, namespace tools, and Codex freeform custom tool support.
- DeepSeek V4 Pro and V4 Flash model presets.
- No-thinking model variants.
- DeepSeek thinking-mode mapping from Codex reasoning effort.
- Codex profile and model catalog installer.
- Legacy profile support for older Codex CLI versions.
- Reversible App DeepSeek Mode with install-state metadata and `restore`.
- `setup`, `doctor --auth`, and `open-report` CLI helpers.
- Local JSONL metadata logs.
- `cache-report` CLI summary.
- Local HTML report at `/report`.
- Report JSON endpoint at `/report/data`.
- Prompt-prefix diagnostics without storing prompt text by default.
- Basic troubleshooting, architecture, cache, privacy, security, and contributing docs.
