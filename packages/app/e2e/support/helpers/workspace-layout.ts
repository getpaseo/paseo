import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { WorkspaceLayoutPersistedStateSchema } from "../../../src/stores/workspace-layout-storage";
import { openTabInLayoutFocused } from "../../../src/stores/workspace-layout-actions";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTab,
} from "../../../src/workspace-tabs/model";
import { getServerId } from "./server-id";

export async function seedForeignPinnedAgentTab(
  page: Page,
  input: { serverId: string; workspaceId: string; agentId: string },
): Promise<void> {
  const raw = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
  if (raw === null) throw new Error("Workspace layout was not persisted");
  const stored = z
    .object({ state: WorkspaceLayoutPersistedStateSchema, version: z.number().optional() })
    .parse(JSON.parse(raw));
  const key = buildWorkspaceTabPersistenceKey(input);
  const layout = key ? stored.state.layoutByWorkspace[key] : null;
  if (!key || !layout) throw new Error(`No persisted layout for workspace ${input.workspaceId}`);
  const opened = openTabInLayoutFocused({
    layout,
    target: { kind: "agent", agentId: input.agentId },
    now: 1,
    placement: { mode: "focused" },
    explorerSidebarPaneId: stored.state.explorerSidebarPaneIdByWorkspace?.[key] ?? null,
  });
  if (!opened) throw new Error("Failed to seed foreign agent tab");
  stored.state = WorkspaceLayoutPersistedStateSchema.parse({
    ...stored.state,
    layoutByWorkspace: { ...stored.state.layoutByWorkspace, [key]: opened.layout },
    pinnedAgentIdsByWorkspace: {
      ...stored.state.pinnedAgentIdsByWorkspace,
      [key]: [...(stored.state.pinnedAgentIdsByWorkspace?.[key] ?? []), input.agentId],
    },
  });
  await page.evaluate(
    (value) => localStorage.setItem("workspace-layout-state", value),
    JSON.stringify(stored),
  );
}

/** Seed the reported hidden Explorer-only layout with 2,250 saved agent draft tabs. */
export async function seedCorruptedWorkspaceLayout(page: Page, workspaceId: string): Promise<void> {
  const raw = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
  if (raw === null) throw new Error("Explorer fixture: workspace layout was not persisted");
  const stored = z
    .strictObject({
      state: WorkspaceLayoutPersistedStateSchema,
      version: z.number().int().nonnegative().optional(),
    })
    .parse(JSON.parse(raw), {
      error: () => "Explorer fixture: invalid persisted workspace layout",
    });
  const key = buildWorkspaceTabPersistenceKey({ serverId: getServerId(), workspaceId });
  if (!key || !Object.hasOwn(stored.state.layoutByWorkspace, key)) {
    throw new Error(`Explorer fixture: no persisted layout for workspace ${workspaceId}`);
  }
  const tabs: WorkspaceTab[] = [
    { tabId: "files", target: { kind: "files" }, createdAt: 1 },
    { tabId: "changes_tree", target: { kind: "changes_tree" }, createdAt: 1 },
    ...Array.from(
      { length: 2250 },
      (_, index): WorkspaceTab => ({
        tabId: `draft_saved_${index}`,
        target: { kind: "draft", draftId: `draft_saved_${index}` },
        createdAt: index + 2,
      }),
    ),
  ];
  const corruptedLayout = {
    root: {
      kind: "pane",
      pane: {
        id: "pane_generated_report_equivalent",
        hidden: true,
        tabIds: tabs.map((tab) => tab.tabId),
        tabs,
        focusedTabId: tabs[tabs.length - 1].tabId,
      },
    },
    focusedPaneId: null,
  };
  stored.state = WorkspaceLayoutPersistedStateSchema.parse({
    ...stored.state,
    layoutByWorkspace: { ...stored.state.layoutByWorkspace, [key]: corruptedLayout },
    explorerPaneIdByWorkspace: {
      ...stored.state.explorerPaneIdByWorkspace,
      [key]: "pane_generated_report_equivalent",
    },
  });
  await page.evaluate(
    (value) => localStorage.setItem("workspace-layout-state", value),
    JSON.stringify(stored),
  );
}

export async function expectAgentAbsentFromWorkspaceLayout(
  page: Page,
  input: { serverId: string; workspaceId: string; agentId: string },
): Promise<void> {
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
      if (!raw) throw new Error("Workspace layout was not persisted");
      const stored = z
        .object({ state: WorkspaceLayoutPersistedStateSchema })
        .parse(JSON.parse(raw));
      const key = `${input.serverId}:${input.workspaceId}`;
      const layout = stored.state.layoutByWorkspace[key];
      const pins = stored.state.pinnedAgentIdsByWorkspace?.[key] ?? [];
      // The persisted tree is validated above; inspect all panes including hidden ones.
      return {
        containsAgent: JSON.stringify(layout).includes(input.agentId),
        pinned: pins.includes(input.agentId),
      };
    })
    .toEqual({ containsAgent: false, pinned: false });
}
