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
2. **You are signed in with ChatGPT.** A ChatGPT account uses the remote model catalog, so the local
   DeepSeek catalog cannot be merged in. In Codex, log out, choose **Sign in another way**, and enter
   your DeepSeek API key. (`setup` does not change a ChatGPT login for you.)

If you want to undo everything, run `codex-deepseek-bridge restore` and restart Codex.

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

The picker shows `deepseek-pro` (stronger) and `deepseek-flash` (faster, cheaper). Each has three
reasoning levels:

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
codex-deepseek-bridge restore           # restore your previous Codex config
codex-deepseek-bridge restore --logout  # also remove the DeepSeek key login the setup created
```

Then restart Codex.
