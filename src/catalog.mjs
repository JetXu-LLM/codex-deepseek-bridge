import { catalogModels, DEFAULT_CODEX_MODEL, DEFAULT_UPSTREAM_MODEL } from "./models.mjs";

export function buildModelCatalog({
  alias = DEFAULT_CODEX_MODEL,
  vision = false,
  upstreamModel = DEFAULT_UPSTREAM_MODEL,
} = {}) {
  return {
    models: catalogModels({
      customAlias: alias,
      customUpstreamModel: upstreamModel,
      vision,
    }),
  };
}

export function buildCodexProfile({
  alias = DEFAULT_CODEX_MODEL,
  baseUrl = "http://127.0.0.1:8787/v1",
  catalogPath,
  provider = "deepseek_bridge",
  codexAuth = false,
} = {}) {
  const escapedCatalogPath = catalogPath.replaceAll("\\", "\\\\");
  const escapedBaseUrl = baseUrl.replaceAll("\\", "\\\\");
  return `model = "${alias}"
model_provider = "${provider}"
model_catalog_json = "${escapedCatalogPath}"
personality = "none"
model_context_window = 1000000
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_supports_reasoning_summaries = true

[model_providers.${provider}]
name = "DeepSeek Codex Bridge"
base_url = "${escapedBaseUrl}"
wire_api = "responses"
${codexAuth ? "requires_openai_auth = true\n" : ""}`;
}

export function buildCodexGlobalBlock({
  alias = DEFAULT_CODEX_MODEL,
  baseUrl = "http://127.0.0.1:8787/v1",
  catalogPath,
  provider = "deepseek_bridge",
  codexAuth = false,
} = {}) {
  return [
    "# >>> codex-deepseek-bridge",
    "# Managed by codex-deepseek-bridge. Remove this block to uninstall the active global profile.",
    buildCodexProfile({ alias, baseUrl, catalogPath, provider, codexAuth }).trimEnd(),
    "# <<< codex-deepseek-bridge",
    "",
  ].join("\n");
}

export function buildCodexLegacyProfile({
  alias = DEFAULT_CODEX_MODEL,
  baseUrl = "http://127.0.0.1:8787/v1",
  catalogPath,
  profileName = "deepseek",
  provider = "deepseek_bridge",
  codexAuth = false,
  includeProvider = true,
} = {}) {
  const escapedCatalogPath = catalogPath.replaceAll("\\", "\\\\");
  const escapedBaseUrl = baseUrl.replaceAll("\\", "\\\\");
  const providerBlock = includeProvider
    ? `[model_providers.${provider}]
name = "DeepSeek Codex Bridge"
base_url = "${escapedBaseUrl}"
wire_api = "responses"
${codexAuth ? "requires_openai_auth = true\n" : ""}
`
    : "";
  return `${providerBlock}[profiles.${profileName}]
model = "${alias}"
model_provider = "${provider}"
model_catalog_json = "${escapedCatalogPath}"
personality = "none"
model_context_window = 1000000
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_supports_reasoning_summaries = true
`;
}

export function buildCodexManagedConfigBlock({
  alias = DEFAULT_CODEX_MODEL,
  baseUrl = "http://127.0.0.1:8787/v1",
  catalogPath,
  provider = "deepseek_bridge",
  profileName = "deepseek",
  activate = false,
  legacyProfile = false,
  codexAuth = false,
} = {}) {
  const parts = [
    "# >>> codex-deepseek-bridge",
    "# Managed by codex-deepseek-bridge.",
  ];
  if (activate) {
    parts.push("# App DeepSeek mode follows. Remove this block or run `codex-deepseek-bridge restore` to restore your prior default.");
    parts.push("# Current verified Codex builds treat model_catalog_json as an override, so GPT models may be hidden while this mode is active.");
    if (codexAuth) {
      parts.push("# Codex API-key login is used for this provider; the stored key is sent only to this configured provider while this block is active.");
    }
    parts.push(buildCodexProfile({ alias, baseUrl, catalogPath, provider, codexAuth }).trimEnd());
  }
  if (legacyProfile) {
    parts.push("# Legacy Codex CLI profile for versions before 0.134.");
    parts.push(buildCodexLegacyProfile({ alias, baseUrl, catalogPath, profileName, provider, codexAuth, includeProvider: !activate }).trimEnd());
  }
  parts.push("# <<< codex-deepseek-bridge", "");
  return parts.join("\n");
}
