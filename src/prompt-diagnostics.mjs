import { stableHash } from "./util.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messageForHash(message) {
  return {
    role: message?.role || "",
    content: message?.content ?? null,
    tool_call_id: message?.tool_call_id ?? null,
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          id: toolCall.id || "",
          type: toolCall.type || "",
          name: toolCall.function?.name || "",
          arguments: toolCall.function?.arguments || "",
        }))
      : undefined,
  };
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (text.match(pattern) || []).length, 0);
}

function volatileSignals(messages) {
  const text = messages.map(messageText).join("\n");
  const signals = {
    isoTimestamps: countMatches(text, [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g]),
    clockTimes: countMatches(text, [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g]),
    tempPaths: countMatches(text, [/\/var\/folders\/[^\s"'`]+/g, /\/tmp\/[^\s"'`]+/g, /\\AppData\\Local\\Temp\\[^\s"'`]+/gi]),
    uuids: countMatches(text, [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi]),
  };
  return Object.fromEntries(Object.entries(signals).filter(([, value]) => value > 0));
}

export function buildPromptDiagnostics(chatBody) {
  const messages = Array.isArray(chatBody.messages) ? chatBody.messages : [];
  const tools = Array.isArray(chatBody.tools) ? chatBody.tools : [];
  const messageHashes = messages.map((message) => stableHash(canonicalJson(messageForHash(message))));
  const messageLengths = messages.map((message) => messageText(message).length);
  const roleSequence = messages.map((message) => message?.role || "unknown");
  const systemMessages = messages.filter((message) => message?.role === "system");

  return {
    model: chatBody.model || "",
    messageCount: messages.length,
    roleSequence,
    messageHashes,
    messageLengths,
    messagesHash: stableHash(canonicalJson(messages.map(messageForHash))),
    systemHash: stableHash(canonicalJson(systemMessages.map(messageForHash))),
    toolsHash: stableHash(canonicalJson(tools)),
    toolNames: tools.map((tool) => tool?.function?.name || tool?.name || tool?.type).filter(Boolean).slice(0, 50),
    stablePrefixHash: stableHash(canonicalJson({ system: systemMessages.map(messageForHash), tools })),
    volatileSignals: volatileSignals(messages),
  };
}

export function comparePromptDiagnostics(previous, current) {
  if (!previous || !current) {
    return null;
  }
  const previousHashes = Array.isArray(previous.messageHashes) ? previous.messageHashes : [];
  const currentHashes = Array.isArray(current.messageHashes) ? current.messageHashes : [];
  let commonPrefixMessages = 0;
  while (
    commonPrefixMessages < previousHashes.length &&
    commonPrefixMessages < currentHashes.length &&
    previousHashes[commonPrefixMessages] === currentHashes[commonPrefixMessages]
  ) {
    commonPrefixMessages += 1;
  }
  const commonPrefixChars = (current.messageLengths || [])
    .slice(0, commonPrefixMessages)
    .reduce((sum, length) => sum + (Number.isFinite(length) ? length : 0), 0);
  const previousPromptCovered = previousHashes.length > 0 ? commonPrefixMessages / previousHashes.length : null;
  return {
    commonPrefixMessages,
    commonPrefixChars,
    previousPromptCovered,
    systemStable: previous.systemHash === current.systemHash,
    toolsStable: previous.toolsHash === current.toolsHash,
    roleSequenceStable: (previous.roleSequence || []).join(">") === (current.roleSequence || []).join(">"),
    stablePrefixStable: previous.stablePrefixHash === current.stablePrefixHash,
  };
}
