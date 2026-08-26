import type { AgentMcpServerStatus } from "@getpaseo/protocol/agent-types";

/**
 * How a status draws. `tone` names the one status token for that signal — a row and the
 * trigger's badge read the same map, so they cannot disagree about what counts as a fault.
 *
 * `connected` has no trailing label on purpose: the check already says it, and a column of
 * "Connected" next to every healthy server buries the two rows that need reading.
 */
export type McpStatusTone = "success" | "warning" | "danger" | "muted";

export interface McpStatusPresentation {
  tone: McpStatusTone;
  /** i18n key under `mcpServers.status`, or null when the icon says enough. */
  labelKey: string | null;
}

const PRESENTATION: Record<AgentMcpServerStatus, McpStatusPresentation> = {
  connected: { tone: "success", labelKey: null },
  connecting: { tone: "muted", labelKey: "connecting" },
  needs_auth: { tone: "warning", labelKey: "needsAuth" },
  failed: { tone: "danger", labelKey: "failed" },
  disabled: { tone: "muted", labelKey: "disabled" },
  unknown: { tone: "muted", labelKey: "unknown" },
};

export function getMcpStatusPresentation(status: AgentMcpServerStatus): McpStatusPresentation {
  return PRESENTATION[status] ?? PRESENTATION.unknown;
}
