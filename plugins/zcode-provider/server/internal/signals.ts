import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";

interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: Record<string, JsonValue>;
}

const ZCODE_OPTIONS_METADATA_KEY = "zcodePermissionOptions";

export function mapPermissionRequest(payload: unknown): ProviderPermissionRequest {
  const request = payload as {
    requestId?: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    reason: string;
    riskLevel: string;
    input: unknown;
    options: ZCodePermissionOption[];
  };
  return {
    // ZCode's permission request carries an optional request id. The tool
    // call id is always there and identifies the request just as well.
    id: request.requestId ?? request.toolCallId,
    name: request.toolName,
    kind: "tool",
    title: request.toolName,
    description: request.reason,
    input:
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, JsonValue>)
        : undefined,
    actions: request.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      behavior: option.response.decision === "allow" ? "allow" : "deny",
    })),
    metadata: {
      [ZCODE_OPTIONS_METADATA_KEY]: request.options as unknown as JsonValue,
    },
  };
}

export function permissionResponseFor(
  request: ProviderPermissionRequest,
  response: ProviderPermissionResponse,
): Record<string, JsonValue> {
  const actionId = "selectedActionId" in response ? response.selectedActionId : undefined;
  if (!actionId) {
    throw new Error("The permission response must name the action the user chose");
  }
  const options = request.metadata?.[ZCODE_OPTIONS_METADATA_KEY];
  const list = Array.isArray(options) ? (options as unknown as ZCodePermissionOption[]) : [];
  const chosen = list.find((option) => option.optionId === actionId);
  if (!chosen) throw new Error(`Unknown permission action: ${actionId}`);
  return chosen.response;
}
