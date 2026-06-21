# Codex DeepSeek Bridge

Use DeepSeek inside the OpenAI Codex app through a tiny local Responses-compatible bridge.

For the full Desktop picker experience, run setup with the explicit Desktop patch opt-in. Codex
then shows `deepseek-pro` and `deepseek-flash` in the model picker. Without that opt-in, the bridge
uses the official config path only and publishes `deepseek-pro`.

## Quick Start

### macOS Apple Silicon

```bash
curl -L -o codex-deepseek-bridge-macos-arm64 https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-macos-arm64
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos-arm64 2>/dev/null || true
chmod +x ./codex-deepseek-bridge-macos-arm64
./codex-deepseek-bridge-macos-arm64 setup --desktop-patch
```

### macOS Intel

```bash
curl -L -o codex-deepseek-bridge-macos-x64 https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-macos-x64
xattr -d com.apple.quarantine ./codex-deepseek-bridge-macos-x64 2>/dev/null || true
chmod +x ./codex-deepseek-bridge-macos-x64
./codex-deepseek-bridge-macos-x64 setup --desktop-patch
```

### Windows PowerShell

```powershell
Invoke-WebRequest -Uri "https://github.com/JetXu-LLM/codex-deepseek-bridge/releases/latest/download/codex-deepseek-bridge-win-x64.exe" -OutFile ".\codex-deepseek-bridge-win-x64.exe"
.\codex-deepseek-bridge-win-x64.exe setup --desktop-patch
```

`setup` asks for your DeepSeek API key in the terminal. The key is not echoed, printed, logged, or
accepted as a command-line argument. After setup finishes, restart Codex.

If you do not want to patch Codex Desktop app files, run `setup` without `--desktop-patch`. That
mode keeps Codex on `deepseek-pro`; the picker may show `Custom` until Codex Desktop fixes custom
catalog rendering.

You can safely run setup again. For example, if you first ran `setup` and later decide you want the
Desktop picker, run `setup --desktop-patch`; the bridge rewrites the same managed block and updates
the catalog instead of duplicating config.

## Desktop Picker Patch

Current Codex Desktop builds can load `model_catalog_json` on the app-server side while the Desktop
renderer still filters custom models out of the visible picker. This is tracked in
[openai/codex#19694](https://github.com/openai/codex/issues/19694). A related open issue for custom
providers, existing chats, and the Desktop picker is
[openai/codex#29156](https://github.com/openai/codex/issues/29156).

The Desktop patch is an explicit local compatibility workaround. It modifies your local Codex
Desktop app files so the picker honors the local catalog. It does not distribute a modified Codex
app.

![Codex Desktop picker showing DeepSeek Pro and DeepSeek Flash after the Desktop picker patch](docs/assets/codex-desktop-deepseek-picker-patched.jpg)

The screenshot above requires `setup --desktop-patch`.

- macOS: patches `Codex.app/Contents/Resources/app.asar`, updates Electron ASAR integrity, and
  re-signs the local app bundle.
- Windows writable installs: patches `resources/app.asar` after backing it up.
- Windows Store installs: creates a writable managed Codex copy under the bridge state directory and
  prints a launcher path. Use that launcher to open the patched copy.

Restore your previous Codex setup and stop the bridge with:

```bash
codex-deepseek-bridge restore
```

If you used a downloaded binary and did not install it on your PATH, run the same binary with
`restore`, for example `./codex-deepseek-bridge-macos-arm64 restore`.

## What Happens

Codex officially supports user-level provider configuration, `model_provider`, `model_providers`,
`openai_base_url`, and `model_catalog_json` in `~/.codex/config.toml`. See the OpenAI Codex docs:
[configuration reference](https://developers.openai.com/codex/config-reference#configtoml),
[custom model providers](https://developers.openai.com/codex/config-advanced#custom-model-providers),
and [OSS mode local providers](https://developers.openai.com/codex/config-advanced#oss-mode-local-providers).

```mermaid
sequenceDiagram
  participant Setup as setup
  participant Config as ~/.codex/config.toml + models.json
  participant Server as Codex app-server
  participant UI as Codex Desktop UI
  participant Gate as Desktop visible-model gate
  participant Bridge as localhost bridge
  participant DS as DeepSeek API

  Setup->>Config: write one reversible managed block
  Config->>Server: model=deepseek-pro, model_catalog_json
  Server-->>UI: returns DeepSeek catalog
  UI->>Gate: applies Desktop visible-model filter
  Gate-->>UI: custom models may be hidden without patch
  UI->>Bridge: /v1/responses
  Bridge->>DS: /chat/completions
```

`setup --desktop-patch` changes only the local Desktop picker filter path. Model calls still go
through the local bridge and then to DeepSeek.

## Login And History

`setup` does not replace your Codex login.

- ChatGPT login stays ChatGPT.
- API-key login stays API-key.
- Existing non-reserved provider history is reused when possible.
- The reserved `openai` provider uses the official `openai_base_url` override instead of redefining
  `[model_providers.openai]`.

ChatGPT cloud history still requires a ChatGPT sign-in. Local history can be scoped by Codex
provider id, so `restore` is the reliable way to return to the exact previous setup.

## Daily Use

```bash
codex-deepseek-bridge doctor
codex-deepseek-bridge doctor --live
codex-deepseek-bridge report
codex-deepseek-bridge restore
```

`report` starts the bridge if needed and opens the local report in your browser:

```text
http://localhost:8787/report
```

The bridge binds to the local loopback interface (`127.0.0.1`) and uploads no telemetry.

## Privacy And Responsibility

- The bridge sends model requests to DeepSeek.
- It stores your DeepSeek key locally with owner-only permissions.
- It can optionally check GitHub releases for updates.
- It does not upload telemetry.
- It does not distribute a modified Codex app.

The optional Desktop patch modifies local Codex Desktop app files on your machine. Review your own
legal, workplace, and contract obligations before using it. This project is provided under
Apache-2.0 without warranty and is not affiliated with OpenAI or DeepSeek.

## Node Install

If you prefer a global command and already have Node:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge setup --desktop-patch
```

## Docs

- [Architecture](docs/architecture.md)
- [Configuration and platforms](docs/platforms-and-upgrades.md)
- [Cache and the report](docs/cache-and-observability.md)
- [Privacy and network](docs/privacy-and-network.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
