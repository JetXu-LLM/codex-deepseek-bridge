export const DEFAULT_CODEX_MODEL = "deepseek-v4-pro";
export const DEFAULT_UPSTREAM_MODEL = "deepseek-v4-pro";
export const LEGACY_CODEX_MODEL = "deepseek-codex";

export const MODEL_PRESETS = [
  {
    id: "deepseek-v4-pro",
    upstreamModel: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    description: "DeepSeek V4 Pro through a local Responses-compatible bridge for OpenAI Codex.",
    thinking: "auto",
    priority: 10,
  },
  {
    id: "deepseek-v4-flash",
    upstreamModel: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "DeepSeek V4 Flash through a local Responses-compatible bridge for OpenAI Codex.",
    thinking: "auto",
    priority: 9,
  },
  {
    id: "deepseek-v4-pro-no-thinking",
    upstreamModel: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (No Thinking)",
    description: "DeepSeek V4 Pro with DeepSeek thinking disabled by the bridge.",
    thinking: "disabled",
    priority: 8,
  },
  {
    id: "deepseek-v4-flash-no-thinking",
    upstreamModel: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash (No Thinking)",
    description: "DeepSeek V4 Flash with DeepSeek thinking disabled by the bridge.",
    thinking: "disabled",
    priority: 7,
  },
];

const PRESETS_BY_ID = new Map(MODEL_PRESETS.map((model) => [model.id, model]));

export function knownModelIds() {
  return MODEL_PRESETS.map((model) => model.id);
}

export function resolveModelRequest(requestedModel, config = {}) {
  const codexModel = requestedModel || config.modelAlias || DEFAULT_CODEX_MODEL;
  const preset = PRESETS_BY_ID.get(codexModel);
  if (preset) {
    return {
      codexModel,
      upstreamModel: preset.upstreamModel,
      thinking: preset.thinking,
      preset,
    };
  }

  if (codexModel === LEGACY_CODEX_MODEL || codexModel === config.modelAlias) {
    return {
      codexModel,
      upstreamModel: config.upstreamModel || DEFAULT_UPSTREAM_MODEL,
      thinking: "auto",
      preset: null,
    };
  }

  return {
    codexModel,
    upstreamModel: codexModel,
    thinking: "auto",
    preset: null,
  };
}

export function catalogModels({
  customAlias,
  customUpstreamModel = DEFAULT_UPSTREAM_MODEL,
  vision = false,
} = {}) {
  const models = [...MODEL_PRESETS];
  if (customAlias && !PRESETS_BY_ID.has(customAlias)) {
    models.push({
      id: customAlias,
      upstreamModel: customUpstreamModel,
      displayName: `${customAlias} via Codex DeepSeek Bridge`,
      description: `${customUpstreamModel} through a local Responses-compatible bridge for OpenAI Codex.`,
      thinking: "auto",
      priority: 6,
    });
  }
  return models.map((model) => modelCatalogEntry(model, { vision }));
}

function reasoningMetadata(model) {
  if (model.thinking === "disabled") {
    return {
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        {
          effort: "high",
          description: "Ignored by the bridge; DeepSeek thinking is disabled",
        },
        {
          effort: "xhigh",
          description: "Ignored by the bridge; DeepSeek thinking is disabled",
        },
      ],
      default_reasoning_summary: "none",
      supports_reasoning_summaries: false,
    };
  }

  return {
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      {
        effort: "high",
        description: "DeepSeek high reasoning effort",
      },
      {
        effort: "xhigh",
        description: "Mapped to DeepSeek max reasoning effort",
      },
    ],
    default_reasoning_summary: "auto",
    supports_reasoning_summaries: true,
  };
}

export function modelCatalogEntry(model, { vision = false } = {}) {
  const reasoning = reasoningMetadata(model);
  return {
    slug: model.id,
    id: model.id,
    display_name: model.displayName,
    displayName: model.displayName,
    description: model.description,
    base_instructions:
      "You are Codex, a coding agent working in the user's local workspace. Help with software tasks end to end: inspect the project before changing it, use tools when useful, keep edits scoped, avoid reverting user changes, verify your work, and report the result clearly.",
    ...reasoning,
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
    input_modalities: vision ? ["text", "image"] : ["text"],
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
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
    supported_in_api: true,
    priority: model.priority,
  };
}
