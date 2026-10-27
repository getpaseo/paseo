export interface HandoffPlan {
  text: string;
}

export function visibleHandoffProfiles<T extends { name: string }>(profiles: readonly T[]): T[] {
  return profiles.filter((profile) => !profile.name.startsWith("Workflow"));
}

/** Extract the plan from both stored and live workflow handoff prompts. */
export function extractHandoffPlan(message: string): HandoffPlan | undefined {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "/paseo-handoff") return undefined;

  const markerLine = lines.find((line) => line.startsWith("PASEO_WORKFLOW_HANDOFF "));
  if (!markerLine) return undefined;
  try {
    const marker: unknown = JSON.parse(markerLine.slice("PASEO_WORKFLOW_HANDOFF ".length));
    if (
      !marker ||
      typeof marker !== "object" ||
      !Reflect.get(marker, "mode") ||
      Reflect.get(marker, "mode") !== "receiver" ||
      typeof Reflect.get(marker, "workflowId") !== "string" ||
      typeof Reflect.get(marker, "planId") !== "string" ||
      typeof Reflect.get(marker, "role") !== "string"
    )
      return undefined;
  } catch {
    return undefined;
  }

  // The plan payload is the final JSON object. Try each object-looking line from
  // the end so pretty-printed plans and escaped newlines are preserved verbatim.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/^\s*\{/.test(lines[index] ?? "")) continue;
    try {
      const payload: unknown = JSON.parse(lines.slice(index).join("\n").trim());
      const plan = payload && typeof payload === "object" ? Reflect.get(payload, "plan") : null;
      if (typeof plan === "string" && plan.trim()) return { text: plan };
    } catch {
      // A later opening brace may belong to prose; keep looking for the payload.
    }
  }
  return undefined;
}

export function handoffPlanTitle(plan: string): string {
  const lines = plan.split(/\r?\n/);
  const heading = lines.find((line) => /^\s*#{1,6}\s+\S/.test(line));
  const source = heading?.replace(/^\s*#{1,6}\s+/, "") ?? lines.find((line) => line.trim()) ?? "";
  const title = source
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}\]()#+.!<>|])/g, "$1")
    .trim();
  return (title || "Plan transféré").slice(0, 200);
}
