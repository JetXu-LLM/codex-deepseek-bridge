# Security

Codex DeepSeek Bridge runs locally and forwards Codex requests to DeepSeek. That makes key handling and local logs important.

## API Keys

- Do not commit real API keys.
- In Profile Mode, prefer passing `DEEPSEEK_API_KEY` through your shell, OS secret manager, or process supervisor.
- In App Login Mode, Codex stores a DeepSeek key through Codex API-key login while the active provider points at the local bridge.
- A DeepSeek API key is not a ChatGPT account and not an OpenAI Platform key.
- When `DEEPSEEK_API_KEY` is absent and `DSCB_BRIDGE_API_KEY` is not set, the bridge accepts Codex's bearer token as the DeepSeek upstream key. This supports App Login Mode.
- When `DSCB_BRIDGE_API_KEY` is set, Codex must present that local bridge token and the bridge uses `DEEPSEEK_API_KEY` for upstream DeepSeek calls.
- Error messages and logs redact `sk-...` style keys and bearer tokens.

## Codex Auth Boundary

Profile Mode does not replace ChatGPT/OpenAI sign-in.

App Login Mode intentionally changes the active local Codex provider and stores a DeepSeek key through Codex API-key auth for the current `CODEX_HOME`. Use it for DeepSeek-key-only app workflows, then undo it with:

```bash
codex-deepseek-bridge restore --logout
```

Codex app sign-in, Codex cloud, remote plugin sync, and workspace features may still require normal ChatGPT/OpenAI authentication. This bridge is a local model path, not a replacement for Codex account services.

## Local Logs

Metadata logs default to:

```text
~/.codex/codex-deepseek-bridge/logs
```

They are used by `/report` and `cache-report`.

By default, logs contain request metadata, response usage, cache fields, prompt hashes, role sequences, lengths, tool hashes, and status fields. They do not contain prompt text.

Set `DSCB_LOG_PAYLOADS=1` only when you intentionally want redacted request and response payloads written to disk for debugging.

Disable metadata logs with:

```bash
DSCB_LOG_DIR=off codex-deepseek-bridge serve
```

## Report Server

The report is served from the same local bridge server:

```text
http://127.0.0.1:8787/report
```

Keep the bridge bound to `127.0.0.1` unless you understand the network exposure. Do not bind it to a public interface with real credentials.

## Reporting Issues

If you find a security issue, do not include secrets, logs, or user transcripts in public issues. Open a minimal issue describing the class of problem and offer to share details privately.

## Supported Versions

Until the project reaches `1.0.0`, only the latest released version is expected to receive security fixes.
