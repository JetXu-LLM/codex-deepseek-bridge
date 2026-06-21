# Platforms And Upgrades

Codex DeepSeek Bridge supports macOS and the Codex-supported Windows line. Windows 11 is the best
target for Desktop validation; recent fully updated Windows 10 is best effort. Windows 7 is not a
meaningful Codex Desktop test target.

The flow is the same on supported systems:

1. Get the bridge (binary, GitHub npm install, or the Path A prompt).
2. Run `setup` and paste your DeepSeek key when the terminal asks for it, unless a key is already
   stored on this machine.
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

### GitHub npm install (if you have Node)

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge setup
```

The npm registry package name is reserved for a later maintainer publish.

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

## Desktop picker patch

Current Codex Desktop builds may hide custom catalog models behind a remote allowlist even after the
app-server returns the DeepSeek catalog. This is tracked upstream in
[openai/codex#19694](https://github.com/openai/codex/issues/19694). Without the Desktop patch,
setup publishes `deepseek-pro` only. With the patch active, setup publishes `deepseek-pro` and
`deepseek-flash`.

Plain `setup` skips the reversible local picker patch and publishes `deepseek-pro` only. Apply the
patch explicitly with `setup --desktop-patch` or `DSCB_DESKTOP_PATCH=on`. The patch makes the picker
use the local catalog's `hidden` flag instead of that allowlist gate.

On macOS, the patch touches:

- `/Applications/Codex.app/Contents/Resources/app.asar`
- `/Applications/Codex.app/Contents/Info.plist`
- `/Applications/Codex.app/Contents/_CodeSignature`
- `/Applications/Codex.app/Contents/MacOS/Codex` when macOS rewrites the root code signature

The bridge backs up those files under `<bridgeHome>/desktop-patch/`, updates Electron's ASAR
integrity hash, and re-signs the app with an ad-hoc local signature. `restore` puts the backups
back, verifies the app bundle, and re-signs locally again only if the restored signature no longer
verifies.

On Windows writable Electron installs, the patch touches:

- `<Codex install>/resources/app.asar`

On Windows Store installs, Windows may block writes under `WindowsApps`. In that case the bridge
mirrors the app into `<bridgeHome>/desktop-patch/windows-store-apps/`, patches that managed copy,
and prints a `Codex-DeepSeek.cmd` launcher path. Use that launcher to open the patched copy. The
normal Windows Store shortcut still opens the unpatched Store app.

If Codex Desktop later removes this allowlist behavior, `setup` detects that the patch target is
absent and leaves the app bundle unchanged.

Apply it explicitly with:

```bash
codex-deepseek-bridge setup --desktop-patch
```

Skip the Desktop patch with:

```bash
DSCB_DESKTOP_PATCH=off codex-deepseek-bridge setup
```

## Files under CODEX_HOME

`CODEX_HOME` defaults to `~/.codex` (`%USERPROFILE%\.codex` on Windows). The bridge writes:

- `config.toml` — one managed block, written after backing up any existing file.
- `<bridgeHome>/models.json` — the active catalog. Config-only setup publishes `deepseek-pro`;
  patched Desktop setup also publishes `deepseek-flash`.
- `<bridgeHome>/deepseek-key` — the stored key (owner-only).
- `<bridgeHome>/install-state.json` — what was changed, the backup path, the resolved port, the
  detected login mode, the install method, and the bridge version.
- `<bridgeHome>/desktop-patch/` — Codex Desktop picker backups, Windows Store managed copies, and
  launchers when that patch is needed.
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

- **GitHub npm install:** prints `npm install -g github:JetXu-LLM/codex-deepseek-bridge`.
- **binary:** downloads the matching release asset, verifies its checksum, and swaps it in place
  (keeping the previous binary for `upgrade --rollback`). It never swaps on a checksum mismatch.
- **source:** prints `git pull && npm install`.

After updating, `upgrade` re-runs the idempotent `setup` reconcile (rewriting `models.json` and the
managed block, preserving your key and port, never touching login), refreshes the Desktop picker
patch only if it was already managed by the bridge or `DSCB_DESKTOP_PATCH=on` is set, and restarts
the bridge. If the model catalog or Desktop patch changed, restart Codex.

The running bridge can also notice a newer release on its own and surface it in the report and in
`version` / `doctor`. It reads only public GitHub release metadata, uploads nothing, and never
auto-installs. Turn it off with `DSCB_UPDATE_CHECK=off` or `DO_NOT_TRACK=1`.

## When Codex or DeepSeek changes

Generated files stay small and reversible. To move forward safely: `upgrade` (or re-run `setup`),
then `doctor`. If DeepSeek ships a new model generation, the upstream mapping is a one-line change
(`DEEPSEEK_MODEL_PRO` / `DEEPSEEK_MODEL_FLASH`); the Codex-facing slugs do not change.
