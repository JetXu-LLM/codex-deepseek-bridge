# Troubleshooting

Start with `doctor`. It checks the bridge, your stored key, the Codex config, and your detected login
state without printing any secret.

```bash
codex-deepseek-bridge doctor
codex-deepseek-bridge doctor --live   # makes one real DeepSeek call through the bridge
```

## The picker still shows only GPT models

Almost always one of two things:

1. **Codex was not restarted.** The model catalog is applied at startup. Quit Codex fully and reopen
   it.
2. **The bridge config is not active.** Run `codex-deepseek-bridge doctor`. It should say
   `Codex config: DeepSeek active`. If it does not, re-run `setup`.

## The picker says Custom or the model submenu is empty

Upgrade to `0.1.10` or newer and re-run `setup`. Current Codex Desktop builds can apply a remote
allowlist to hidden models before rendering the picker. The app-server can already return the
DeepSeek catalog correctly, but the renderer may still filter out custom models, leaving the UI at
`Custom`. This is tracked upstream in [openai/codex#19694](https://github.com/openai/codex/issues/19694).

Without the Desktop patch, setup intentionally publishes `deepseek-pro` only. `deepseek-flash` is
published only when the Desktop compatibility patch is active.

Plain `setup` leaves the Desktop app untouched. To apply the reversible local Desktop compatibility
patch, run:

```bash
codex-deepseek-bridge setup --desktop-patch
codex-deepseek-bridge doctor
```

`doctor` should report `Desktop compatibility patch: patched`. If it says
`unrecognized Desktop build`, your Codex Desktop version changed enough that the bridge refused to
patch it. Open an issue with the Codex version and the `doctor` output.

On Windows Store installs, setup may print a managed launcher path. Use that launcher to open the
patched copy; the normal Windows Store shortcut still opens the unpatched app.

If you want to undo the active setup, run `codex-deepseek-bridge restore`; it restores Codex config,
restores the Desktop patch when present, stops the bridge, and keeps the local DeepSeek key for a
future setup run. For a full local cleanup, run `codex-deepseek-bridge restore --purge`.

On macOS, maintainers can verify the exact desktop app-server response with:

```bash
npm run verify:codex-app
```

## `setup --desktop-patch` says "not writable" (macOS)

This is almost always macOS **App Management**, not file permissions. macOS protects apps in
`/Applications` from being modified by other programs, even when the files are owned by you. The fix
is a one-time permission, not `sudo`:

1. Open System Settings &rarr; Privacy & Security &rarr; **App Management**.
2. Turn it on for the terminal you run the bridge from (Terminal, iTerm, or your editor).
3. Re-run `./codex-deepseek-bridge-macos setup --desktop-patch`.

`sudo` does not help here — App Management is enforced per app and the root user is not exempt. If you
would rather not grant it, config-only `setup` already gives you `deepseek-pro`; the patch only adds
`deepseek-flash` and the full picker labels.

## DeepSeek calls fail

Run the live check to tell the three causes apart:

```bash
codex-deepseek-bridge doctor --live
```

- **Bridge offline** → start it: `codex-deepseek-bridge start`.
- **Key rejected** → your DeepSeek key is wrong or missing. Re-run `codex-deepseek-bridge setup`
  and paste the right key when the terminal asks for it.
- **DeepSeek returned an error status** → an upstream problem. Open the report for details with
  `codex-deepseek-bridge report`.

## Codex says the model catalog is invalid

Run:

```bash
codex debug models
```

If it mentions `supported_reasoning_levels`, upgrade to `0.1.2` or newer and re-run `setup`. Older
bridge builds wrote the previous Codex catalog field names, so Codex ignored the DeepSeek picker.

## Codex history is missing

Run:

```bash
codex-deepseek-bridge doctor
```

If your existing local API-key/GPT project history disappeared after setup, upgrade to `0.1.9` or
newer and run `setup` again. Codex Desktop scopes local chat lists by provider id. Current setup
looks at your original config and local thread database, then preserves history when it can do so
without overriding reserved built-in provider IDs:

- Non-reserved providers, such as `codex`, are reused while their base URL points at the bridge.
- `openai` uses the official `openai_base_url` override.
- Other reserved providers and machines with no useful history use the independent
  `deepseek_bridge` provider. In that case old chats are unchanged but may be hidden while DeepSeek
  is active; `restore` brings the previous config back.

ChatGPT cloud-only history is separate. If `doctor` says `Codex login: api-key`, Codex still has no
ChatGPT token for cloud history endpoints. To recover ChatGPT-backed cloud history while keeping the
stored DeepSeek key, sign out of API-key auth in Codex, sign in with ChatGPT, then run
`codex-deepseek-bridge setup` again. If you want a full cleanup instead, including removing the
stored DeepSeek key, run:

```bash
codex-deepseek-bridge restore --logout
```

Then sign in to Codex with ChatGPT and run `codex-deepseek-bridge setup` again. Current bridge
versions keep your Codex login unchanged and use the local stored DeepSeek key for model calls when
that key still exists.

If you only ran `restore` and did not use `restore --logout`, the stored DeepSeek key remains on this
machine. Running `setup` again can reuse it without asking you to paste the key again.

## MCP or plugin tools say `unsupported call`

Run `setup` with the latest bridge. Current setup stops stale background bridge processes before it
starts the new one, so Codex does not keep talking to an older daemon.

Older builds could return namespace tools in a shape Codex would not execute, such as
`mcp__node_repljs`, `mcp__computer_uselist_apps`, or even a fully qualified
`mcp__computer_use__list_apps` where Codex expected `name: "list_apps"` plus
`namespace: "mcp__computer_use"`.

## macOS asks for the `Codex Storage Key` password (sometimes twice)

This is a side effect of the Desktop patch. Editing `app.asar` invalidates Codex's original Apple
signature, so the bridge re-signs the bundle locally (ad-hoc). macOS ties Keychain access to the
signature, so a locally signed Codex looks like a different app and re-prompts — sometimes once per
Keychain item, which is why you can see two prompts. Click **Always Allow** on each.

Plain `setup` does not edit or re-sign Codex.app. Run `codex-deepseek-bridge doctor`; it reports when
the Codex signature is `local/ad-hoc`.

Run `codex-deepseek-bridge restore` first. When bridge backups are available, restore puts the
original app files and Apple signature back. If doctor still reports `local/ad-hoc`, or restore says
the Desktop signature backups are missing, reinstall or update Codex from the official source to
restore Apple's signature. Re-running `--desktop-patch` re-signs it again, so the prompts return if
you re-patch.

## The bridge stopped after a reboot (Windows)

The background process does not survive a reboot or a new login on Windows. Start it again:

```powershell
codex-deepseek-bridge start
```

## macOS Gatekeeper blocks the binary

Unsigned binaries trigger Gatekeeper. Clear the quarantine attribute and make it executable:

```bash
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos 2>/dev/null
chmod +x ./codex-deepseek-bridge-macos
```

You can also right-click the binary in Finder and choose **Open** once.

## Windows SmartScreen warns about the binary

Choose **More info → Run anyway**. The binary is unsigned for now; verify the download against its
published `.sha256` if you want extra assurance.

## Choosing model and reasoning

Config-only setup uses `deepseek-pro`. With the Desktop compatibility patch active, the picker also
shows `deepseek-flash` (faster, cheaper). Each model has three reasoning levels:

- **none** — no thinking, fastest.
- **high** — DeepSeek thinking.
- **xhigh** — DeepSeek maximum thinking (default).

## Cache hit rate is lower than expected

Run `codex-deepseek-bridge report`. DeepSeek cache hits need a stable, fully matching prefix. If the
system prompt, tool schema, or model changes between turns, or volatile values (timestamps, temp
paths, UUIDs) enter the prompt, expect misses. The report classifies prefix risk and points at the
likely cause. The bridge does not rewrite prompts; it reports so you can diagnose.

## Going back to GPT

```bash
codex-deepseek-bridge restore           # restore config/picker patch and stop the bridge
codex-deepseek-bridge restore --logout  # also remove an API-key login from older bridge setups
codex-deepseek-bridge restore --purge   # also remove bridge state, key, logs, and backups
```

Then restart Codex.
