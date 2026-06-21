# Codex DeepSeek Bridge

**Use DeepSeek inside the OpenAI Codex app.** Run one setup, restart Codex, and your model picker
shows two DeepSeek models — `deepseek-pro` and `deepseek-flash` — running through a tiny local
bridge on your own machine.

You bring a DeepSeek API key. The bridge does the translation. Nothing leaves your machine except the
calls to DeepSeek.

On current macOS Codex Desktop builds, the app may hide custom catalog models behind its remote
allowlist. `setup` detects that case and asks before applying the optional local picker patch.
`restore` undoes the patch.

---

## What you need

- The **Codex app** installed (signed in or not).
- A **DeepSeek API key** (`https://platform.deepseek.com`).
- macOS or Windows.

## Get started

### Already using Codex? Paste one prompt.

Open Codex and paste this. It reads this repo, installs the bridge, configures Codex, and starts the
background service. It will ask you to paste your DeepSeek key into the terminal if the key is not
already stored on this machine — never into the chat.

```text
Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek.
Treat my DeepSeek API key as a secret: never print it, never write it into a file you show me, never
put it in your replies, never commit it.
Steps:
1. Read https://github.com/JetXu-LLM/codex-deepseek-bridge and follow its setup.
2. If I have Node, install with npm; otherwise download the binary for my OS from the latest release.
3. Run setup. If no DeepSeek key is already stored on this machine, ask me to paste it in the
   terminal (stdin), not in this chat.
4. Back up my Codex config, then point Codex at the DeepSeek bridge (models deepseek-pro, deepseek-flash).
   If Codex Desktop hides custom catalog models, explain the reversible local picker patch and apply
   it only with my explicit approval, or by running setup with --desktop-patch.
5. Do not replace my Codex login. Keep my ChatGPT login if I have one, and keep API-key mode if
   that is how I already use Codex. Existing local history should stay visible. The bridge should
   use the local stored DeepSeek key, not Codex's login token.
6. Start the bridge in the background and confirm http://127.0.0.1:8787/report loads.
7. Tell me to restart Codex, and show me the command to start the bridge again next time.
```

Then **restart Codex** and pick `deepseek-pro` or `deepseek-flash`.

### Starting fresh? Use the binary.

No Node required. Download the binary for your computer:

- macOS (Apple Silicon):
  [codex-deepseek-bridge-macos-arm64](https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-macos-arm64)
- macOS (Intel):
  [codex-deepseek-bridge-macos-x64](https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-macos-x64)
- Windows:
  [codex-deepseek-bridge-win-x64.exe](https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-win-x64.exe)

**macOS** (Terminal, in your Downloads folder):

```bash
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos-arm64 2>/dev/null
chmod +x ./codex-deepseek-bridge-macos-arm64
./codex-deepseek-bridge-macos-arm64 setup
```

**Windows** (PowerShell, in your Downloads folder; if SmartScreen warns, choose "More info → Run
anyway"):

```powershell
.\codex-deepseek-bridge-win-x64.exe setup
```

`setup` asks you to paste your DeepSeek key into the terminal when no key is already stored,
configures Codex, and starts the bridge. If your macOS Codex Desktop build hides custom catalog
models, it asks before applying the optional picker compatibility patch. The key is not echoed. Then
**restart Codex**.

<details>
<summary>Have Node installed? Install from GitHub with npm.</summary>

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge setup
```

The npm registry package name is reserved for a later maintainer publish. Until then, use the GitHub
install command above or the release binary.
</details>

## Signing in

`setup` stores your DeepSeek key for the local bridge and leaves your Codex login alone.

- **Signed in with ChatGPT?** Keep it. Your Codex history stays available while the model picker uses
  the local DeepSeek catalog.
- **Already in API-key login mode?** Keep it. Existing local Codex history stays visible because the
  bridge uses Codex's local provider id while pointing that provider at DeepSeek. ChatGPT cloud-only
  history still requires a ChatGPT sign-in.
- **Re-running after `restore`?** If you did not use `restore --logout`, the stored DeepSeek key is
  reused and setup does not ask for it again.

While the bridge is active, Codex runs on DeepSeek; your GPT models come back when you
[go back](#go-back-anytime).

## Keep the bridge running

The bridge runs in the background and powers both Codex and the local report. After a reboot, start
it again with one command:

```bash
codex-deepseek-bridge start
```

Tip: **star this repo** so the command is easy to find later.

## Choose how hard it thinks

Both models expose three reasoning levels in Codex:

- **none** — no thinking, fastest.
- **high** — DeepSeek thinking (default).
- **xhigh** — DeepSeek maximum thinking.

`deepseek-pro` is the stronger model; `deepseek-flash` is faster and cheaper.

## See what's happening

Open the local report to watch calls, tokens, DeepSeek cache hits, and latency:

```
http://127.0.0.1:8787/report
```

It is read-only and local. Prompt text is not stored.

## What you get today

- DeepSeek in the Codex app on macOS and Windows.
- Two clean models with three reasoning levels. `deepseek-pro` is the default.
- Existing local API-key Codex history remains visible after setup.
- An optional macOS Desktop picker patch for Codex builds that hide custom catalog models.
- A local usage and cache report.
- One-command upgrades.
- Full reversibility.

## What's coming

- Image input, as soon as DeepSeek ships multimodal.
- Deeper cache insights and cost estimates.
- Richer report panels.

Star and watch the repo to follow along.

## Privacy

- The bridge runs on `127.0.0.1` only.
- It calls DeepSeek to answer Codex, and (optionally) checks GitHub for new releases. Nothing else
  leaves your machine.
- Your key is stored locally with restricted permissions and is never printed or committed.
- No telemetry, no project backend. Turn the update check off with `DSCB_UPDATE_CHECK=off` or
  `DO_NOT_TRACK=1`.

## Go back anytime

```bash
codex-deepseek-bridge restore           # restore your previous Codex config and Desktop picker patch
codex-deepseek-bridge restore --logout  # also remove an API-key login from older bridge setups
```

Then restart Codex.

## Update

```bash
codex-deepseek-bridge upgrade           # update to the latest release and restart the bridge
codex-deepseek-bridge upgrade --check   # just check if a newer version exists
```

## Learn more

- [Architecture](docs/architecture.md)
- [Configuration and platforms](docs/platforms-and-upgrades.md)
- [Cache and the report](docs/cache-and-observability.md)
- [Privacy and network](docs/privacy-and-network.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md)

## Not this

This is a focused DeepSeek bridge for Codex, not a multi-provider router and not a cloud service.
It does not add new UI; on macOS it only fixes Codex Desktop's current custom-model picker filter.
While it is active, Codex runs on DeepSeek; use `restore` to return to GPT.

## License

Apache License 2.0. See [LICENSE](LICENSE).
