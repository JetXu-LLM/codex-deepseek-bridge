# FAQ

This page is the public FAQ for Codex DeepSeek Bridge. If you open an issue, please check this page
first and include the diagnostics listed at the end.

## Which command should I run after setup?

If setup already finished and the bridge process is simply not running, start it again:

```bash
codex-deepseek-bridge start
```

If you downloaded a self-contained binary, use the same file you used for setup:

```bash
./codex-deepseek-bridge-macos start
./codex-deepseek-bridge-macos-x64 start
```

```powershell
.\codex-deepseek-bridge-win-x64.exe start
```

Use `setup` again when you want to upgrade, repair the Codex config, change your stored DeepSeek
key, or opt in to `setup --desktop-patch`.

## Does setup update the bridge?

Yes. `setup` checks the latest GitHub release before changing Codex. If a newer version exists, it
asks before upgrading, keeps your stored key, logs, report data, and backups, then continues the same
setup command.

You can also run:

```bash
codex-deepseek-bridge upgrade
codex-deepseek-bridge upgrade --check
```

`start` starts the local bridge process. It does not do a guided upgrade first, although the running
bridge can later show update notices in `doctor`, `version`, and the local report.

## The bridge stopped. What should I do?

Run `start` with the same command style you used for setup. On macOS, the background process survives
closing the terminal, but it still will not survive every reboot or manual kill. On Windows, run
`start` again after a reboot or new login.

If you are not sure whether the bridge is running:

```bash
codex-deepseek-bridge doctor
```

## Codex reports `ws://127.0.0.1:8787/v1/responses` or `GET /v1/responses`

Upgrade to `0.1.26` or newer and run `setup` again.

The bridge supports the normal HTTP/SSE Responses path (`POST /v1/responses`). Older setup output
could route the bridge through Codex's built-in OpenAI provider with `openai_base_url`; that provider
may try WebSocket transport. Current setup writes the bridge as a custom HTTP-only provider with
`supports_websockets = false` and migrates the older `openai_base_url` state.

## Codex says DeepSeek is unavailable or calls fail

Run:

```bash
codex-deepseek-bridge doctor
codex-deepseek-bridge doctor --live
```

`doctor --live` makes one real DeepSeek call through the bridge. If it fails, open:

```text
http://localhost:8787/report
```

Use the port shown by `doctor` if it is not `8787`.

## Why does Codex show `Custom` instead of `deepseek-pro`?

Plain `setup` leaves the official Codex app untouched and publishes `deepseek-pro`. Current Codex
Desktop builds may render custom catalog models as `Custom`; the request still routes to
`deepseek-pro`.

If you want the visible picker entries `deepseek-pro` and `deepseek-flash`, run:

```bash
codex-deepseek-bridge setup --desktop-patch
```

This modifies your local Codex Desktop app bundle. It is optional and reversible with `restore`.

## Does setup change my Codex login?

No. `setup` detects Codex login state for reporting, but it does not log you out or replace your
login. The DeepSeek key is stored locally and used by the bridge for model calls.

## Where is my DeepSeek key stored?

The key is stored locally at:

```text
<bridgeHome>/deepseek-key
```

By default, `<bridgeHome>` is:

```text
<CODEX_HOME>/codex-deepseek-bridge
```

The key is read from the terminal prompt, `--from-stdin`, or `DEEPSEEK_API_KEY`. It is not accepted
as a command-line argument and should never be pasted into an issue.

## The API key prompt looks blank. Did paste work?

In `0.1.26` and newer, interactive setup masks pasted characters with `*` and prints the character
count after receiving the key. It rejects empty keys, spaces, line breaks, control characters, and
non-ASCII or full-width characters.

It does not enforce an unofficial DeepSeek key prefix or length.

## macOS asks for Keychain access

This happens only after the optional Desktop patch locally re-signs Codex. Click **Always Allow** if
you want to keep using the patched app. To undo it:

```bash
codex-deepseek-bridge restore
```

If Keychain prompts remain after restore, reinstall or update Codex from the official source to
restore Apple's signature.

## How do I undo everything?

To restore Codex config and stop the bridge:

```bash
codex-deepseek-bridge restore
```

To also remove the stored DeepSeek key, logs, backups, and bridge state:

```bash
codex-deepseek-bridge restore --purge
```

Then restart Codex.

## What should I include in a bug report?

Do not paste API keys, bearer tokens, full prompt payloads, private logs, or secrets.

Please include:

```bash
codex-deepseek-bridge version
codex-deepseek-bridge doctor
codex-deepseek-bridge doctor --live
```

Also include the Codex version, your OS, the exact command you ran, and the relevant redacted error
from `http://localhost:8787/report` or `codex-deepseek-bridge report`.
