const HANDOFF_COMMAND = "/paseo-handoff";
const HANDOFF_MARKER = "PASEO_WORKFLOW_HANDOFF ";
const HANDOFF_INSTRUCTION =
  "Execute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.";
const EXECUTOR_ROLES = new Set([
  "executor-trivial",
  "executor-bounded",
  "executor-diagnostic",
  "executor-complex",
  "executor-critical",
  "executor-standard",
  "executor-advanced",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHandoffMessage(message: string): { plan: string } | null {
  const [command, markerLine, instruction, ...payloadLines] = message.split("\n");
  if (
    command !== HANDOFF_COMMAND ||
    !markerLine?.startsWith(HANDOFF_MARKER) ||
    instruction !== HANDOFF_INSTRUCTION ||
    payloadLines.length === 0
  ) {
    return null;
  }

  try {
    const metadata: unknown = JSON.parse(markerLine.slice(HANDOFF_MARKER.length));
    const payload: unknown = JSON.parse(payloadLines.join("\n"));
    if (
      !isRecord(metadata) ||
      metadata.mode !== "receiver" ||
      typeof metadata.workflowId !== "string" ||
      metadata.workflowId.length === 0 ||
      typeof metadata.planId !== "string" ||
      metadata.planId.length === 0 ||
      typeof metadata.role !== "string" ||
      !EXECUTOR_ROLES.has(metadata.role) ||
      !isRecord(payload) ||
      typeof payload.plan !== "string" ||
      payload.plan.trim().length === 0
    ) {
      return null;
    }
    return { plan: payload.plan };
  } catch {
    return null;
  }
}
