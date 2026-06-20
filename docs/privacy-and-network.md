# Privacy And Network Model

Codex DeepSeek Bridge is designed to be local-first.

## Network Requests

The bridge makes no requests to a project-owned backend, database, analytics service, or telemetry endpoint.

At runtime, network access is limited to:

- DeepSeek API requests that are needed to answer Codex model calls.
- Public GitHub release metadata if a future update-check feature is added.

The current version does not include an automatic update checker.

## Localhost By Default

The bridge binds to:

```text
127.0.0.1:8787
```

Do not bind it to a public interface unless you understand the risk. If you expose the bridge beyond localhost, protect it with `DSCB_BRIDGE_API_KEY`.

## Logs

Metadata logs default to:

```text
~/.codex/codex-deepseek-bridge/logs
```

They power `/report` and `cache-report`.

By default, metadata logs do not store prompt text. They store request summaries, usage fields, cache hit/miss fields, prompt hashes, role sequences, lengths, and tool hashes.

Disable logs:

```bash
DSCB_LOG_DIR=off codex-deepseek-bridge serve
```

Enable redacted payload logs only when debugging locally:

```bash
DSCB_LOG_PAYLOADS=1 codex-deepseek-bridge serve
```

## API Keys

Profile Mode uses `DEEPSEEK_API_KEY` in the bridge process for upstream DeepSeek requests. It does not use or modify your ChatGPT login.

App Login Mode is different. It is for users who want to use the Codex app with only a DeepSeek API key. In that mode, Codex stores the DeepSeek key through Codex API-key login, the active provider points at `http://127.0.0.1:8787/v1`, and the bridge receives the key as a bearer token from Codex. The bridge then uses that bearer token as the DeepSeek upstream key.

A DeepSeek API key is not a ChatGPT account and not an OpenAI Platform key. App Login Mode works because Codex can store API-key login credentials and the active provider is localhost. If you leave App Login Mode, run:

```bash
codex-deepseek-bridge restore --logout
```

This restores the config and removes the Codex-stored API-key credential for the current Codex home.

If Codex app, Codex cloud, plugin sync, or workspace features require ChatGPT/OpenAI authentication, those features still depend on normal Codex sign-in and may be unavailable in DeepSeek-key-only App Login Mode.

Do not put real keys in `.env.example`, README examples, issues, screenshots, or logs.

## Future Update Checks

If the project adds one-click or in-report updates later, the update check should read only public GitHub release metadata and should remain transparent to the user. It should not send local usage, prompts, project paths, API keys, or environment data anywhere.
