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
published only when the Desktop picker patch is active.

`setup` detects that Desktop bundle and asks before applying a reversible local picker patch. Run:

```bash
codex-deepseek-bridge setup
codex-deepseek-bridge doctor
```

`doctor` should report `Desktop picker patch: patched`. If it says `needs setup`, run
`codex-deepseek-bridge setup --desktop-patch` to apply the patch explicitly. If it says
`unrecognized Desktop build`, your Codex Desktop version changed enough that the bridge refused to
patch it. Open an issue with the Codex version and the `doctor` output.

On Windows Store installs, setup may print a managed launcher path. Use that launcher to open the
patched copy; the normal Windows Store shortcut still opens the unpatched app.

If you want to undo everything, run `codex-deepseek-bridge restore` and restart Codex.

On macOS, maintainers can verify the exact desktop app-server response with:

```bash
npm run verify:codex-app
```

## DeepSeek calls fail

Run the live check to tell the three causes apart:

```bash
codex-deepseek-bridge doctor --live
```

- **Bridge offline** → start it: `codex-deepseek-bridge start`.
- **Key rejected** → your DeepSeek key is wrong or missing. Re-run `codex-deepseek-bridge setup`
  and paste the right key when the terminal asks for it.
- **DeepSeek returned an error status** → an upstream problem. Open the report for details:
  `http://127.0.0.1:8787/report`.

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

## The bridge stopped after a reboot (Windows)

The background process does not survive a reboot or a new login on Windows. Start it again:

```powershell
codex-deepseek-bridge start
```

Tip: star the repo so the command is easy to find later.

## macOS Gatekeeper blocks the binary

Unsigned binaries trigger Gatekeeper. Clear the quarantine attribute and make it executable:

```bash
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos-arm64 2>/dev/null
chmod +x ./codex-deepseek-bridge-macos-arm64
```

You can also right-click the binary in Finder and choose **Open** once.

## Windows SmartScreen warns about the binary

Choose **More info → Run anyway**. The binary is unsigned for now; verify the download against its
published `.sha256` if you want extra assurance.

## Choosing model and reasoning

Config-only setup uses `deepseek-pro`. With the Desktop picker patch active, the picker also shows
`deepseek-flash` (faster, cheaper). Each model has three reasoning levels:

- **none** — no thinking, fastest.
- **high** — DeepSeek thinking (default).
- **xhigh** — DeepSeek maximum thinking.

## Cache hit rate is lower than expected

Open `http://127.0.0.1:8787/report`. DeepSeek cache hits need a stable, fully matching prefix. If the
system prompt, tool schema, or model changes between turns, or volatile values (timestamps, temp
paths, UUIDs) enter the prompt, expect misses. The report classifies prefix risk and points at the
likely cause. The bridge does not rewrite prompts; it reports so you can diagnose.

## Going back to GPT

```bash
codex-deepseek-bridge restore           # restore your previous Codex config and Desktop picker patch
codex-deepseek-bridge restore --logout  # also remove an API-key login from older bridge setups
```

Then restart Codex.
