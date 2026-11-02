import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginHostProps, PluginNewWorkspace } from "@getpaseo/plugin/client";
import { branchNameFromRef, type PickerItem } from "@/screens/new-workspace-picker-item";
import type { SetupCommands } from "@/screens/new-workspace/setup-model";
import { cloneAndFreeze } from "../freeze";

/** What the New workspace screen shows at render; the plugin reads it, never writes it. */
export interface NewWorkspaceView {
  project: { id: string; name: string } | null;
  /** What the screen will create. */
  isolation: "local" | "worktree";
  baseItem: PickerItem | null;
  branch: string | null;
  metadata: Readonly<Record<string, JsonValue>>;
  locked: boolean;
}

function toBaseRef(item: PickerItem | null): PluginNewWorkspace["baseRef"] {
  if (!item) return null;
  return item.kind === "branch"
    ? { type: "branch", name: branchNameFromRef(item.refName) }
    : { type: "change-request", number: item.item.number };
}

export function toPluginNewWorkspace(input: {
  host: PluginHostProps["host"];
  view: NewWorkspaceView;
  commands: SetupCommands;
}): PluginNewWorkspace {
  const { host, view, commands } = input;
  return {
    host: { id: host.id, label: host.label },
    project: cloneAndFreeze(view.project),
    isolation: view.isolation,
    baseRef: toBaseRef(view.baseItem),
    branch: view.branch,
    metadata: cloneAndFreeze(view.metadata),
    ...commands,
  };
}
