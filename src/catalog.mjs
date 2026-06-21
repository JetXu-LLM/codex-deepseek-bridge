import { catalogModels, DEFAULT_CODEX_MODEL } from "./models.mjs";

// Codex Desktop scopes local history by the active provider id. Using Codex's
// built-in local provider id keeps existing API-key/GPT local history visible
// while the provider's base URL points at this bridge.
export const BRIDGE_PROVIDER_ID = "codex";
export const BRIDGE_PROVIDER_NAME = "DeepSeek (via Codex DeepSeek Bridge)";

export const MANAGED_BLOCK_START = "# >>> codex-deepseek-bridge";
export const MANAGED_BLOCK_END = "# <<< codex-deepseek-bridge";

export function buildModelCatalog({ vision = false } = {}) {
  return {
    models: catalogModels({ vision }),
  };
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// The one managed config.toml block (doc 03 §2.2). DeepSeek-only, written at the
// top of config.toml so its root keys win, fully reversible by `restore`.
export function buildManagedConfigBlock({
  model = DEFAULT_CODEX_MODEL,
  provider = BRIDGE_PROVIDER_ID,
  baseUrl = "http://127.0.0.1:8787/v1",
  catalogPath,
  reasoningEffort = "high",
  requiresOpenAiAuth = false,
} = {}) {
  const lines = [
    MANAGED_BLOCK_START,
    "# Managed by codex-deepseek-bridge. Run `codex-deepseek-bridge restore` to undo.",
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider)}`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    "",
    `[model_providers.${provider}]`,
    `name = ${tomlString(BRIDGE_PROVIDER_NAME)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    `requires_openai_auth = ${requiresOpenAiAuth ? "true" : "false"}`,
    MANAGED_BLOCK_END,
    "",
  ];
  return lines.join("\n");
}
