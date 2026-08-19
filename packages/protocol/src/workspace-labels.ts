export const WORKSPACE_LABEL_COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type WorkspaceLabelColor = (typeof WORKSPACE_LABEL_COLORS)[number];

export interface WorkspaceLabelDefinition {
  name: string;
  color: WorkspaceLabelColor;
}

export function normalizeWorkspaceLabelName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function workspaceLabelKey(name: string): string {
  return normalizeWorkspaceLabelName(name).toLowerCase();
}
