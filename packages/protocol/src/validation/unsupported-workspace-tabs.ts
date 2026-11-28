import type { SessionOutboundMessage } from "../messages.js";
import {
  isUnknownWorkspaceSharedTabTarget,
  MAX_WORKSPACE_SHARED_TABS,
} from "../workspace-tab-layout.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateField(input: unknown, key: string, update: (value: unknown) => unknown): unknown {
  if (!isRecord(input)) return input;
  const previous = input[key];
  const next = update(previous);
  return next === previous ? input : { ...input, [key]: next };
}

function filterSplit(input: unknown, omitted: ReadonlySet<string>): unknown {
  if (!isRecord(input) || !Array.isArray(input.nodes)) return input;
  const nodes = input.nodes.map((node: unknown) => {
    if (
      !isRecord(node) ||
      node.kind !== "pane" ||
      !Array.isArray(node.tabIds) ||
      node.tabIds.length > MAX_WORKSPACE_SHARED_TABS
    ) {
      return node;
    }
    const tabIds = node.tabIds.filter((id: unknown) => typeof id !== "string" || !omitted.has(id));
    return { ...node, tabIds };
  });
  return { ...input, nodes };
}

function filterLayout(input: unknown): unknown {
  if (
    !isRecord(input) ||
    !Array.isArray(input.tabs) ||
    input.tabs.length > MAX_WORKSPACE_SHARED_TABS
  )
    return input;
  const omitted = new Set<string>();
  const tabs = input.tabs.filter((tab: unknown) => {
    if (
      !isRecord(tab) ||
      typeof tab.tabId !== "string" ||
      !tab.tabId.length ||
      !isRecord(tab.target) ||
      !isUnknownWorkspaceSharedTabTarget(tab.target)
    ) {
      return true;
    }
    omitted.add(tab.tabId);
    return false;
  });
  if (!omitted.size) return input;

  return updateField({ ...input, tabs }, "split", (split) => filterSplit(split, omitted));
}

const filterDescriptor = (value: unknown) => updateField(value, "tabLayout", filterLayout);
const filterWorkspaceField = (value: unknown) => updateField(value, "workspace", filterDescriptor);

/** Called only after validation fails, for known messages that carry a shared layout. */
export function omitUnsupportedWorkspaceTabs(message: SessionOutboundMessage): unknown {
  switch (message.type) {
    case "fetch_workspaces_response":
      return updateField(message, "payload", (payload) =>
        updateField(payload, "entries", (entries) => {
          if (!Array.isArray(entries)) return entries;
          const next = entries.map(filterDescriptor);
          return next.some((entry, index) => entry !== entries[index]) ? next : entries;
        }),
      );
    case "workspace.tabs.apply.response":
      return updateField(message, "payload", (payload) =>
        updateField(payload, "state", filterLayout),
      );
    case "workspace_update":
    case "workspace.create.update":
    case "agent.create.update":
    case "open_project_response":
    case "create_paseo_worktree_response":
      return updateField(message, "payload", filterWorkspaceField);
    case "creation.subscribe.response":
      return updateField(message, "payload", (payload) =>
        updateField(payload, "snapshot", filterWorkspaceField),
      );
    case "agent.create.response":
      return updateField(message, "payload", (payload) =>
        updateField(payload, "creation", filterWorkspaceField),
      );
    case "workspace.create.response":
      return updateField(message, "payload", (payload) =>
        updateField(filterWorkspaceField(payload), "creation", filterWorkspaceField),
      );
    default:
      return message;
  }
}
