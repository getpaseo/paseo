import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
} from "@getpaseo/protocol/workspace-labels";

export function buildWorkspaceLabelPicker(input: {
  labels: readonly WorkspaceLabelDefinition[];
  assigned: readonly string[];
  query: string;
}) {
  const query = normalizeWorkspaceLabelName(input.query);
  const assigned = new Set(input.assigned.map(workspaceLabelKey));
  const rows = input.labels
    .filter((label) => label.name.toLowerCase().includes(query.toLowerCase()))
    .map((label) => ({
      name: label.name,
      color: label.color,
      assigned: assigned.has(workspaceLabelKey(label.name)),
    }));
  return {
    rows,
    create: { name: query },
  };
}

export function shouldCloseWorkspaceLabelPicker(source: "row" | "checkbox"): boolean {
  return source === "row";
}
