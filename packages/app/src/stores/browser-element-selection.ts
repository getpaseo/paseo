import { create } from "zustand";
import { getNavigationActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  useWorkspaceLayoutStore,
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
} from "@/stores/workspace-layout-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ElementContextChip {
  id: string;
  tag: string;
  text: string;
  selector: string;
  url: string;
  reactSource: BrowserElementSelection["reactSource"];
  formatted: string;
}

interface ElementContextState {
  chipsByAgent: Record<string, ElementContextChip[]>;
  addChip: (agentKey: string, chip: ElementContextChip) => void;
  removeChip: (agentKey: string, chipId: string) => void;
  clearChips: (agentKey: string) => void;
  getChips: (agentKey: string) => ElementContextChip[];
  consumeFormattedContext: (agentKey: string) => string | null;
}

let chipIdCounter = 0;

export const useElementContextStore = create<ElementContextState>((set, get) => ({
  chipsByAgent: {},
  addChip: (agentKey, chip) => {
    set((state) => {
      const existing = state.chipsByAgent[agentKey] ?? [];
      return { chipsByAgent: { ...state.chipsByAgent, [agentKey]: [...existing, chip] } };
    });
  },
  removeChip: (agentKey, chipId) => {
    set((state) => {
      const existing = state.chipsByAgent[agentKey];
      if (!existing?.length) return state;
      const next = existing.filter((c) => c.id !== chipId);
      if (next.length === 0) {
        const copy = { ...state.chipsByAgent };
        delete copy[agentKey];
        return { chipsByAgent: copy };
      }
      return { chipsByAgent: { ...state.chipsByAgent, [agentKey]: next } };
    });
  },
  clearChips: (agentKey) => {
    set((state) => {
      if (!state.chipsByAgent[agentKey]?.length) return state;
      const next = { ...state.chipsByAgent };
      delete next[agentKey];
      return { chipsByAgent: next };
    });
  },
  getChips: (agentKey) => get().chipsByAgent[agentKey] ?? [],
  consumeFormattedContext: (agentKey) => {
    const chips = get().chipsByAgent[agentKey];
    if (!chips?.length) return null;
    const text = chips.map((c) => c.formatted).join("\n\n");
    get().clearChips(agentKey);
    return text;
  },
}));

function buildAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export interface BrowserElementSelection {
  tag: string;
  text: string;
  selector: string;
  attributes: Record<string, string>;
  url: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  boundingRect: { x: number; y: number; width: number; height: number };
  reactSource: {
    fileName: string | null;
    lineNumber: number | null;
    columnNumber: number | null;
    componentName: string | null;
  } | null;
  parentChain: string[];
  children: string[];
}

function buildCanvasStorageKey(workspaceCanvasKey: string): string {
  return `paseo:workspace-canvas:${workspaceCanvasKey}`;
}

interface CanvasGroup {
  groupId: string;
  tabIds: string[];
  label: string;
}

/**
 * Insert a browser element selection as context into the associated agent's draft.
 * Finds the agent by:
 * 1. Looking for a group containing this browser tab and an agent tab
 * 2. Falling back to the only agent in the workspace
 */
export async function insertBrowserElementContext(
  browserId: string,
  selection: BrowserElementSelection,
): Promise<boolean> {
  const workspace = getNavigationActiveWorkspaceSelection();
  if (!workspace) return false;

  const workspaceKey = buildWorkspaceTabPersistenceKey(workspace);
  if (!workspaceKey) return false;

  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!layout) return false;

  const allTabs = collectAllTabs(layout.root);
  const browserTabId = allTabs.find(
    (t) => t.target.kind === "browser" && t.target.browserId === browserId,
  )?.tabId;

  // Try to find agent via canvas group
  let agentId: string | null = null;

  if (browserTabId) {
    try {
      const raw = await AsyncStorage.getItem(buildCanvasStorageKey(workspaceKey));
      if (raw) {
        const parsed = JSON.parse(raw) as { groups?: CanvasGroup[] };
        const groups = parsed.groups ?? [];
        for (const group of groups) {
          if (group.tabIds.includes(browserTabId)) {
            for (const tabId of group.tabIds) {
              const tab = allTabs.find((t) => t.tabId === tabId);
              if (tab?.target.kind === "agent") {
                agentId = tab.target.agentId;
                break;
              }
            }
            if (agentId) break;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback: if only one agent in workspace, use that
  if (!agentId) {
    const agentTabs = allTabs.filter((t) => t.target.kind === "agent");
    if (agentTabs.length === 1 && agentTabs[0]?.target.kind === "agent") {
      agentId = agentTabs[0].target.agentId;
    }
  }

  if (!agentId) return false;

  const formatted = formatElementChip(selection);
  chipIdCounter += 1;

  const chip: ElementContextChip = {
    id: `elem-${chipIdCounter}-${Date.now()}`,
    tag: selection.tag,
    text: selection.text.slice(0, 60).trim(),
    selector: selection.selector,
    url: selection.url,
    reactSource: selection.reactSource,
    formatted,
  };

  useElementContextStore.getState().addChip(buildAgentKey(workspace.serverId, agentId), chip);

  return true;
}

function formatElementChip(sel: BrowserElementSelection): string {
  const textPreview = sel.text.length > 200 ? sel.text.slice(0, 200).trim() + "…" : sel.text.trim();
  const html = sel.outerHTML.length > 800 ? sel.outerHTML.slice(0, 800).trim() + "…" : sel.outerHTML.trim();

  const parts: string[] = [];

  // Source location (most useful for dev)
  if (sel.reactSource?.fileName) {
    const loc = [
      sel.reactSource.fileName,
      sel.reactSource.lineNumber != null ? `:${sel.reactSource.lineNumber}` : "",
      sel.reactSource.columnNumber != null ? `:${sel.reactSource.columnNumber}` : "",
    ].join("");
    parts.push(`source: ${sel.reactSource.componentName ?? sel.tag} @ ${loc}`);
  }

  parts.push(`selector: ${sel.selector}`);

  if (textPreview) {
    parts.push(`text: ${JSON.stringify(textPreview)}`);
  }

  parts.push(`size: ${sel.boundingRect.width}×${sel.boundingRect.height}`);

  const keyStyles = Object.entries(sel.computedStyles)
    .filter(([k]) => ["display", "position", "font-size", "color", "background-color"].includes(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  if (keyStyles) {
    parts.push(`styles: ${keyStyles}`);
  }

  if (sel.parentChain.length > 0) {
    parts.push(`parents: ${sel.parentChain.slice(0, 3).join(" > ")}`);
  }

  return [
    `<element-context url="${sel.url}">`,
    parts.map((p) => `  ${p}`).join("\n"),
    `  html: ${html}`,
    `</element-context>`,
  ].join("\n");
}
