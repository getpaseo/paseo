import type { AgentPermissionRequest } from "./agent/agent-sdk-types.js";

const ALLOWED_TOKEN_SET = ["mcp", "paseo", "speak"];
const DENIED_TOKEN_SET = [
  "bash",
  "shell",
  "terminal",
  "command",
  "execute",
  "edit",
  "write",
  "read",
  "fetch",
  "http",
  "web",
];

function containsAny(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function stringifyMetadata(metadata: unknown): string {
  try {
    return JSON.stringify(metadata ?? {})?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

/**
 * Voice assistant policy: allow only MCP/paseo/speak tool requests.
 * All non-tool permission requests are denied.
 */
export function isVoicePermissionAllowed(request: AgentPermissionRequest): boolean {
  if (request.kind !== "tool") {
    return false;
  }

  const normalizedName = request.name.trim().toLowerCase();
  if (!normalizedName) {
    return false;
  }

  if (normalizedName === "speak") {
    return true;
  }
  if (normalizedName.includes("mcp") || normalizedName.includes("paseo")) {
    return true;
  }

  if (normalizedName !== "codextool") {
    return false;
  }

  const metadataText = stringifyMetadata({
    metadata: request.metadata ?? null,
    input: request.input ?? null,
  });
  if (!metadataText) {
    return false;
  }

  const mentionsAllowedTooling = containsAny(metadataText, ALLOWED_TOKEN_SET);
  const mentionsDeniedTooling = containsAny(metadataText, DENIED_TOKEN_SET);
  return mentionsAllowedTooling && !mentionsDeniedTooling;
}
