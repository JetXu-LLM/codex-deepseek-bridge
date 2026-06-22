# Privacy And Network Model

Codex DeepSeek Bridge is local-first. There is no project-owned backend, database, analytics service,
or telemetry endpoint.

## Network requests

At runtime, outbound network access is limited to:

- DeepSeek API requests needed to answer Codex model calls.
- Public GitHub release metadata for the optional update check.

The update check reads only `releases/latest`, uploads nothing, and never auto-installs. Turn it off
with `DSCB_UPDATE_CHECK=off` or `DO_NOT_TRACK=1`.

## Localhost by default

The bridge binds to `127.0.0.1:8787`. Do not bind it to a public interface unless you understand the
risk. If you deliberately expose it beyond localhost, set `DSCB_BRIDGE_API_KEY`: the incoming bearer
then gates the bridge and the upstream DeepSeek key must come from the environment or the stored key
file.

## Your DeepSeek key

- The key is read from `--from-stdin` or `DEEPSEEK_API_KEY` only — never from a command-line
  argument.
- It is stored at `<bridgeHome>/deepseek-key` with owner-only permissions (`chmod 600` on macOS, an
  owner-only ACL on Windows).
- It is never printed, logged, committed, or placed in a Codex prompt or session log.
- Error messages and logs redact `sk-...` keys and `Bearer ...` tokens.

At request time the bridge resolves the key in this order: process environment, stored key file, then
the bearer Codex forwards.

A DeepSeek API key is not a ChatGPT account and not an OpenAI Platform key. While the bridge is
active, Codex runs on DeepSeek; use `restore` to return to your previous setup.

## Logs

Logs default to `<bridgeHome>/logs`. They store redacted raw request and response payloads, request
summaries, usage and cache fields, prompt hashes, role sequences, lengths, and tool hashes. Disable
all logs with `DSCB_LOG_DIR=off`, or keep metadata while disabling payloads with
`DSCB_LOG_PAYLOADS=0` or `--no-log-payloads`.

## Do not leak keys

Never put a real key in `README` examples, issues, screenshots, logs, or committed files.
