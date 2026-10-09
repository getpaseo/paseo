import type { Page } from "@playwright/test";
import { z } from "zod";
import { WorkspaceLayoutPersistedStateSchema } from "../../../src/stores/workspace-layout-storage";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTab,
} from "../../../src/workspace-tabs/model";
import { getServerId } from "./server-id";

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
