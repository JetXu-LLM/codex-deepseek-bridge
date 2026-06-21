// Codex-facing model slugs. These never change. The upstream DeepSeek model each
// one maps to is configurable (DEEPSEEK_MODEL_PRO / DEEPSEEK_MODEL_FLASH) so a new
// DeepSeek generation is a one-line default change, not a Codex-facing rename.
export const DEFAULT_CODEX_MODEL = "deepseek-pro";
export const UPSTREAM_PRO_DEFAULT = "deepseek-v4-pro";
export const UPSTREAM_FLASH_DEFAULT = "deepseek-v4-flash";
export const DEFAULT_UPSTREAM_MODEL = UPSTREAM_PRO_DEFAULT;

export const MODEL_PRESETS = [
  {
    slug: "deepseek-pro",
    displayName: "DeepSeek Pro",
    description: "DeepSeek Pro via the local Codex DeepSeek Bridge.",
    // Codex app-server sorts custom catalog entries by ascending priority and
    // marks the first returned entry as the desktop default.
    priority: 1,
  },
  {
    slug: "deepseek-flash",
    displayName: "DeepSeek Flash",
    description: "DeepSeek Flash via the local Codex DeepSeek Bridge.",
    priority: 2,
  },
];

const REASONING_EFFORTS = [
  { effort: "none", reasoningEffort: "none", description: "No thinking (fastest)" },
  { effort: "high", reasoningEffort: "high", description: "DeepSeek thinking" },
  { effort: "xhigh", reasoningEffort: "xhigh", description: "DeepSeek maximum thinking" },
];

export function resolveUpstreamModels(env = process.env) {
  return {
    "deepseek-pro": env.DEEPSEEK_MODEL_PRO || UPSTREAM_PRO_DEFAULT,
    "deepseek-flash": env.DEEPSEEK_MODEL_FLASH || UPSTREAM_FLASH_DEFAULT,
  };
}

export function knownModelIds() {
  return MODEL_PRESETS.map((model) => model.slug);
}

// Fold any requested model (including legacy or dated slugs like deepseek-v4-pro)
// to one of the two known Codex-facing slugs so old sessions keep working.
export function foldToKnownSlug(requestedModel) {
  const value = String(requestedModel || DEFAULT_CODEX_MODEL).toLowerCase();
  if (value.includes("flash")) {
    return "deepseek-flash";
  }
  return "deepseek-pro";
}

export function resolveModelRequest(requestedModel, config = {}) {
  const upstreamModels = config.upstreamModels || resolveUpstreamModels();
  const slug = foldToKnownSlug(requestedModel);
  return {
    codexModel: requestedModel || DEFAULT_CODEX_MODEL,
    slug,
    upstreamModel: upstreamModels[slug] || upstreamModels["deepseek-pro"] || UPSTREAM_PRO_DEFAULT,
  };
}

export function catalogModels({ vision = false, includeFlash = true } = {}) {
  return MODEL_PRESETS
    .filter((model) => includeFlash || model.slug !== "deepseek-flash")
    .map((model) => modelCatalogEntry(model, { vision }));
}

function reasoningMetadata() {
  return {
    default_reasoning_level: "xhigh",
    supported_reasoning_levels: REASONING_EFFORTS.map(({ effort, description }) => ({ effort, description })),
    default_reasoning_summary: "auto",
    supports_reasoning_summaries: true,
    defaultReasoningEffort: "xhigh",
    supportedReasoningEfforts: REASONING_EFFORTS.map(({ reasoningEffort, description }) => ({
      reasoningEffort,
      description,
    })),
  };
}

export function modelCatalogEntry(model, { vision = false } = {}) {
  const inputModalities = vision ? ["text", "image"] : ["text"];
  return {
    model: model.slug,
    slug: model.slug,
    id: model.slug,
    display_name: model.displayName,
    displayName: model.displayName,
    description: model.description,
    base_instructions:
      "You are Codex, a coding agent working in the user's local workspace. Help with software tasks end to end: inspect the project before changing it, use tools when useful, keep edits scoped, avoid reverting user changes, verify your work, and report the result clearly.",
    ...reasoningMetadata(),
    context_window: 1000000,
    max_context_window: 1000000,
    max_output_tokens: 384000,
    effective_context_window_percent: 95,
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    supports_parallel_tool_calls: true,
    supports_search_tool: false,
    supports_image_detail_original: vision,
    support_verbosity: false,
    default_verbosity: "low",
    truncation_policy: {
      mode: "tokens",
      limit: 20000,
    },
    input_modalities: inputModalities,
    inputModalities,
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    additionalSpeedTiers: [],
    service_tiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availability_nux: null,
    availabilityNux: null,
    upgrade: null,
    upgradeInfo: null,
    model_messages: {
      instructions_template:
        "{{ personality }}\n\nYou are Codex, a coding agent working in the user's local workspace. Help with software tasks end to end: inspect the project before changing it, use tools when useful, keep edits scoped, avoid reverting user changes, verify your work, and report the result clearly.",
      instructions_variables: {
        personality_default: "",
        personality_friendly: "",
        personality_pragmatic: "",
      },
    },
    visibility: "list",
    hidden: false,
    isDefault: model.slug === DEFAULT_CODEX_MODEL,
    supportsPersonality: false,
    supported_in_api: true,
    priority: model.priority,
  };
}
