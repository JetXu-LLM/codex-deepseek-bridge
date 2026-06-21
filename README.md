# Codex DeepSeek Bridge

**Use DeepSeek inside the OpenAI Codex app.** Run one setup, restart Codex, and your model picker
shows two DeepSeek models — `deepseek-pro` and `deepseek-flash` — running through a tiny local
bridge on your own machine.

You bring a DeepSeek API key. The bridge does the translation. Nothing leaves your machine except the
calls to DeepSeek.

---

## What you need

- The **Codex app** installed (signed in or not).
- A **DeepSeek API key** (`https://platform.deepseek.com`).
- macOS or Windows.

## Get started

### Already using Codex? Paste one prompt.

Open Codex and paste this. It reads this repo, installs the bridge, configures Codex, and starts the
background service. It will ask you to paste your DeepSeek key into the terminal — not into the chat.

```text
Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek.
Treat my DeepSeek API key as a secret: never print it, never write it into a file you show me, never
put it in your replies, never commit it.
Steps:
1. Read https://github.com/JetXu-LLM/codex-deepseek-bridge and follow its setup.
2. If I have Node, install with npm; otherwise download the binary for my OS from the latest release.
3. Run the setup so it asks me to paste my DeepSeek API key in the terminal (stdin), not in this chat.
4. Back up my Codex config, then point Codex at the DeepSeek bridge (models deepseek-pro, deepseek-flash).
5. If I am not signed in to Codex, sign me in with my DeepSeek key. If I am signed in with ChatGPT,
   do not change my login — tell me to log out in Codex, choose "Sign in another way", and enter my
   DeepSeek key.
6. Start the bridge in the background and confirm http://127.0.0.1:8787/report loads.
7. Tell me to restart Codex, and show me the command to start the bridge again next time.
```

Then **restart Codex** and pick `deepseek-pro` or `deepseek-flash`.

### Starting fresh? Use the binary.

No Node required. Download the binary for your computer:

- macOS (Apple Silicon): [codex-deepseek-bridge-macos-arm64](#)
- macOS (Intel): [codex-deepseek-bridge-macos-x64](#)
- Windows: [codex-deepseek-bridge-win-x64.exe](#)

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

`setup` asks you to paste your DeepSeek key into the terminal, configures Codex, and starts the
bridge. The key is not echoed. Then **restart Codex**.

<details>
<summary>Have Node installed? Use npm instead.</summary>

```bash
npm install -g codex-deepseek-bridge
codex-deepseek-bridge setup
```

Before the npm package is published, install from GitHub:
`npm install -g github:JetXu-LLM/codex-deepseek-bridge`.
</details>

## Signing in

- **Not signed in to Codex?** Setup signs you in with your DeepSeek key. Open Codex and start coding.
- **Signed in with ChatGPT?** Your login is left alone. To switch this machine to DeepSeek, log out in
  Codex, choose **Sign in another way**, and enter your DeepSeek API key.

A DeepSeek key is not a ChatGPT account. While the bridge is active, Codex runs on DeepSeek; your GPT
models come back when you [go back](#go-back-anytime).

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
- Two clean models with three reasoning levels.
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
codex-deepseek-bridge restore           # restore your previous Codex config
codex-deepseek-bridge restore --logout  # also remove the DeepSeek key login the setup created
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

This is a focused DeepSeek bridge for Codex, not a multi-provider router, not a Codex UI mod, and not
a cloud service. While it is active, Codex runs on DeepSeek; use `restore` to return to GPT.

## License

MIT
