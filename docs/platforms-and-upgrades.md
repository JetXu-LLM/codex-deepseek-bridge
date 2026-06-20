# Platforms And Upgrades

Codex DeepSeek Bridge has one mental model across macOS, Windows, WSL, and Linux:

1. install the package
2. choose Profile Mode or App Login Mode
3. start the localhost bridge
4. verify with `doctor`
5. open the local report
6. restore cleanly when you leave app mode

## Mode Selection

Use **Profile Mode** when you already sign in to Codex with ChatGPT or OpenAI. It creates a `deepseek` profile and keeps your normal Codex login and GPT sessions intact.

Use **App Login Mode** when you do not have a ChatGPT/OpenAI Codex login and want to use the Codex app with a DeepSeek API key. It temporarily points Codex at the local bridge and stores the DeepSeek key through Codex API-key login.

Use **App DeepSeek Mode** only when you intentionally want Codex app local sessions to route through DeepSeek by default. Current verified Codex builds may treat `model_catalog_json` as an override, so GPT models may be hidden while this mode is active.

## macOS

Profile Mode:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
export DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve --daemon
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge doctor --live
codex --profile deepseek
```

App Login Mode:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
export DEEPSEEK_API_KEY="your_deepseek_api_key"
printf "%s\n" "$DEEPSEEK_API_KEY" | codex-deepseek-bridge app-login --from-stdin
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge open-report
```

Restore App Login Mode:

```bash
codex-deepseek-bridge restore --logout
```

Restart Codex after activation or restore.

## Windows PowerShell

Profile Mode:

```powershell
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
$env:DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge doctor --live
codex --profile deepseek
```

App Login Mode:

```powershell
npm install -g github:JetXu-LLM/codex-deepseek-bridge
$env:DEEPSEEK_API_KEY="your_deepseek_api_key"
$env:DEEPSEEK_API_KEY | codex-deepseek-bridge app-login --from-stdin
codex-deepseek-bridge doctor --auth
codex-deepseek-bridge open-report
```

Restore:

```powershell
codex-deepseek-bridge restore --logout
```

If PowerShell blocks `npm` scripts, use Windows' normal execution-policy guidance for local development machines before rerunning the install.

## WSL

Native Windows Codex uses `%USERPROFILE%\.codex`. Codex inside WSL uses Linux `~/.codex` unless you set `CODEX_HOME`.

Choose one environment and keep Codex plus the bridge together:

- If the Codex app agent runs in native Windows, install and run the bridge in Windows.
- If the Codex app agent runs in WSL, install and run the bridge in WSL.
- If you deliberately share state, set `CODEX_HOME` so both sides point at the same Codex home.

Example WSL Profile Mode:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
export DEEPSEEK_API_KEY="your_deepseek_api_key"
codex-deepseek-bridge serve
codex --profile deepseek
```

## Codex Homes And Credentials

Generated files live under `CODEX_HOME`:

- `deepseek.config.toml`
- `codex-deepseek-bridge/models.json`
- `codex-deepseek-bridge/install-state.json`
- `config.toml` managed block only when activation or legacy compatibility is requested

Codex credentials may live in `auth.json` or in the operating system credential store, depending on Codex configuration. In App Login Mode, the stored API-key credential is a DeepSeek key for this local bridge workflow. Use `restore --logout` to remove it when you leave the mode.

## Updating The Bridge

From GitHub:

```bash
npm install -g github:JetXu-LLM/codex-deepseek-bridge
codex-deepseek-bridge install --model deepseek-v4-pro
codex-deepseek-bridge doctor --auth
```

After npm publication:

```bash
npm install -g codex-deepseek-bridge@latest
codex-deepseek-bridge install --model deepseek-v4-pro
codex-deepseek-bridge doctor --auth
```

Restart Codex after reinstalling profiles or activating/restoring app mode.

## Codex Or DeepSeek Changes

Codex provider configuration and DeepSeek APIs can evolve. The bridge keeps generated files small and reversible so users can update safely:

- upgrade the package
- rerun `codex-deepseek-bridge install`
- rerun `doctor --auth`
- rerun `doctor --live` when a DeepSeek key is available
- restore app mode if the visual model selector behaves unexpectedly

If DeepSeek adds multimodal input for the selected model, enable image input only after verifying the current API shape:

```bash
DEEPSEEK_ENABLE_VISION=1 codex-deepseek-bridge serve
```
