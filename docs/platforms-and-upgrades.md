# Platforms And Upgrades

Codex DeepSeek Bridge supports macOS and Windows. The flow is the same on both:

1. Get the bridge (binary, npm, or the Path A prompt).
2. Run `setup` and paste your DeepSeek key when the terminal asks for it.
3. Restart Codex.
4. Re-run `start` after a reboot or when the bridge is not running.

## Install methods

### Self-contained binary (no Node)

Download the binary for your OS from the latest GitHub release, then run `setup` and `start`. macOS
requires clearing the quarantine attribute; Windows may warn through SmartScreen.

```bash
# macOS (Apple Silicon)
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos-arm64 2>/dev/null
chmod +x ./codex-deepseek-bridge-macos-arm64
./codex-deepseek-bridge-macos-arm64 setup
```

```powershell
# Windows (PowerShell). If SmartScreen warns: More info -> Run anyway.
.\codex-deepseek-bridge-win-x64.exe setup
```

### npm (if you have Node)

```bash
npm install -g codex-deepseek-bridge
codex-deepseek-bridge setup
```

Before the npm package is published: `npm install -g github:JetXu-LLM/codex-deepseek-bridge`.

## The key is read from stdin

Interactive `setup` asks you to paste your DeepSeek key into the terminal without echoing it.
Automation can pass the key through `--from-stdin` or `DEEPSEEK_API_KEY`. The key is never accepted
as a command-line argument and never printed, logged, or committed. It is stored at
`<bridgeHome>/deepseek-key` with owner-only permissions.

## Starting the bridge again

The bridge runs in the background and powers both Codex and the report.

```bash
codex-deepseek-bridge start
```

- macOS starts a detached process that survives closing the terminal.
- Windows starts a background process; re-run `start` after a reboot or new login.

`start` is idempotent: if the bridge is already running it reports the port and exits.

## Files under CODEX_HOME

`CODEX_HOME` defaults to `~/.codex` (`%USERPROFILE%\.codex` on Windows). The bridge writes:

- `config.toml` — one managed block, written after backing up any existing file.
- `<bridgeHome>/models.json` — the two-model catalog.
- `<bridgeHome>/deepseek-key` — the stored key (owner-only).
- `<bridgeHome>/install-state.json` — what was changed, the backup path, the resolved port, the
  detected login mode, the install method, and the bridge version.
- `<bridgeHome>/bridge.pid`, `bridge.stdout.log`, `bridge.stderr.log` — daemon bookkeeping.

`<bridgeHome>` defaults to `<CODEX_HOME>/codex-deepseek-bridge`.

## Ports

`setup` resolves a port (default 8787; the next free port if 8787 is taken) and writes the same value
into the managed block and the running process. `--port` overrides it. Re-running `setup` rewrites
the block to the resolved port.

## Upgrading

```bash
codex-deepseek-bridge upgrade           # update to the latest release and restart the bridge
codex-deepseek-bridge upgrade --check   # print installed and latest versions, change nothing
```

`upgrade` updates per install method:

- **npm:** runs `npm install -g codex-deepseek-bridge@latest`.
- **binary:** downloads the matching release asset, verifies its checksum, and swaps it in place
  (keeping the previous binary for `upgrade --rollback`). It never swaps on a checksum mismatch.
- **source:** prints `git pull && npm install`.

After updating, `upgrade` re-runs the idempotent `setup` reconcile (rewriting `models.json` and the
managed block, preserving your key and port, never touching login) and restarts the bridge. If the
model catalog changed, it tells you to restart Codex.

The running bridge can also notice a newer release on its own and surface it in the report and in
`version` / `doctor`. It reads only public GitHub release metadata, uploads nothing, and never
auto-installs. Turn it off with `DSCB_UPDATE_CHECK=off` or `DO_NOT_TRACK=1`.

## When Codex or DeepSeek changes

Generated files stay small and reversible. To move forward safely: `upgrade` (or re-run `setup`),
then `doctor`. If DeepSeek ships a new model generation, the upstream mapping is a one-line change
(`DEEPSEEK_MODEL_PRO` / `DEEPSEEK_MODEL_FLASH`); the Codex-facing slugs do not change.
