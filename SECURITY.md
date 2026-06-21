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
forwards from older configs that still set `requires_openai_auth = true`. Current generated configs
use `requires_openai_auth = false`, so the bridge does not need Codex's login token. If
`DSCB_BRIDGE_API_KEY` is set, the incoming bearer only gates the bridge and the upstream key must
come from the environment or the stored file.

## Login safety

- `setup` detects the Codex login mode for reporting, but leaves ChatGPT, API-key, none, and
  uncertain states unchanged.
- `setup` never calls `codex logout`.
- `restore --logout` is the explicit, user-invoked way to remove an API-key login and the stored
  DeepSeek key.

## Reversibility

`setup` backs up `config.toml` before writing and records the backup path. `restore` prefers
restoring that exact backup; otherwise it strips only the managed block. It always takes a
pre-restore backup first, so no config write is destructive without a recoverable copy.

`setup` may also offer to patch Codex Desktop's local picker bundle when the app hides custom catalog
models behind its remote allowlist. This requires interactive confirmation, `setup --desktop-patch`,
or `DSCB_DESKTOP_PATCH=on`; non-interactive default setup does not silently modify the app bundle.

On macOS, the bridge backs up `app.asar`, `Info.plist`, and the code-signature directory before
patching. Signing may also rewrite the root executable's embedded signature, so the bridge backs up
that file too. It then updates Electron's ASAR integrity metadata and re-signs the app locally.
`restore` puts those backups back, verifies the bundle, and performs a local re-sign only if the
restored bundle does not verify.

On Windows writable installs, the bridge backs up and patches `resources/app.asar`. On Windows Store
installs, it may create a managed writable copy under `<bridgeHome>/desktop-patch/windows-store-apps/`
and a launcher under `<bridgeHome>/desktop-patch/launchers/`; `restore` removes that managed copy and
launcher.

This project does not distribute a modified Codex app. The optional Desktop patch is a local
compatibility workaround for a Codex Desktop picker issue and is provided without warranty. Review
your local legal, workplace, and contract obligations before choosing it.

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
