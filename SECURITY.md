# Security

Codex DeepSeek Bridge runs locally and forwards Codex requests to DeepSeek. Key handling and local
logs are the security-sensitive parts.

## The DeepSeek key

The key is a secret and is handled accordingly:

- It is read from `--from-stdin` or `DEEPSEEK_API_KEY` only — never as a command-line argument (which
  would land in shell history and process listings).
- It is never placed in a Codex prompt or in `~/.codex/sessions` logs.
- It is stored at `<bridgeHome>/deepseek-key` with owner-only permissions (`chmod 600` on macOS, an
  owner-only ACL on Windows).
- It is never printed, logged, or committed. Error messages and logs redact `sk-...` keys and
  `Bearer ...` tokens.

Key resolution at request time: process environment, then the stored key file, then the bearer Codex
forwards (because the provider uses `requires_openai_auth = true`). If `DSCB_BRIDGE_API_KEY` is set,
the incoming bearer only gates the bridge and the upstream key must come from the environment or the
stored file.

## Login safety

- `setup` auto-signs you in with `codex login --with-api-key` only when no existing Codex auth is
  detected, and only by piping the key over stdin.
- `setup` never calls `codex logout`. A ChatGPT user is only ever told how to switch login.
- `restore --logout` is the explicit, user-invoked way to remove the API-key login that setup
  created.

## Reversibility

`setup` backs up `config.toml` before writing and records the backup path. `restore` prefers
restoring that exact backup; otherwise it strips only the managed block. It always takes a
pre-restore backup first, so no write is destructive without a recoverable copy.

## Network and report

The bridge binds `127.0.0.1` only. Outbound access is limited to DeepSeek and (optionally) public
GitHub release metadata for the update check, which uploads nothing and can be disabled with
`DSCB_UPDATE_CHECK=off` or `DO_NOT_TRACK=1`. The report is read-only and served from the same local
process; do not expose the bridge to a public interface.

## Binary distribution

Release binaries are published with a `.sha256` for verification. They are unsigned for now, so macOS
shows Gatekeeper and Windows shows SmartScreen; the README documents how to proceed. `upgrade`
verifies a downloaded binary's checksum before swapping and keeps the previous binary for rollback;
it never swaps on a mismatch.

## Reporting issues

If you find a security issue, do not include secrets, logs, or transcripts in public issues. Open a
minimal issue describing the class of problem and offer to share details privately.

## Supported versions

Until `1.0.0`, only the latest released version is expected to receive security fixes.
