import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectSubagentRowGone,
  expectSubagentRowVisible,
  openSubagentFromCompactTrack,
  seedSubagent,
} from "../support/helpers/subagents";
import {
  backToList,
  closeSheet,
  expectNoSheetOpen,
  expectOneSheetOpen,
  expectOpenTabCount,
  openSheetAsTab,
  expectDeclinedDiscardPrompt,
  expectSheetAtSnap,
  replaceSheetFileText,
  selectTabFromSwitcher,
  sheet,
  sheetHeader,
  tapSheetBackdrop,
} from "../support/helpers/sheet";

const FILE_LINK = "linked.ts:3";

function promptMentioning(target: string): string {
  return [
    "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
    "Return JSON only with fields 'title' and 'branch'.",
    "",
    "<user-prompt>",
    `Open \`${target}\` now`,
    "</user-prompt>",
  ].join("\n");
}

test("compact opens files and subagents in a sheet, leaving the tabs for agents", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "compact-workspace-sheet-",
    title: "Sheet parent",
    initialPrompt: promptMentioning(FILE_LINK),
  });
  try {
    const gate = await installDaemonWebSocketGate(page);
    const linkedPath = path.join(workspace.cwd, "linked.ts");
    await writeFile(linkedPath, "one\ntwo\nthree\n", "utf8");
    const child = await seedSubagent(
      { client: workspace.client, repoPath: workspace.cwd, workspaceId: workspace.workspaceId },
      { parentId: workspace.agentId, title: "Sheet child" },
    );
    const grandchild = await seedSubagent(
      { client: workspace.client, repoPath: workspace.cwd, workspaceId: workspace.workspaceId },
      { parentId: child.id, title: "Sheet grandchild" },
    );
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: workspace.agentId });
    await expectOpenTabCount(page, 1);

    await test.step("a chat file link opens the file in a sheet", async () => {
      const fileLink = page.getByText(FILE_LINK, { exact: true });
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.click();

      const fileSheet = sheet(page, "linked.ts");
      await expect(fileSheet).toBeVisible();
      await expect(fileSheet.getByText("three")).toBeVisible();
      await expectSheetAtSnap(page, "linked.ts");
      await expect(
        sheetHeader(page, "linked.ts").getByRole("button", { name: "Open as tab" }),
      ).toHaveCount(0);
      await expectOpenTabCount(page, 1);
      await closeSheet(page, "linked.ts");
    });

    await test.step("a subagent's row shows the facts its sheet shows", async () => {
      await page.getByTestId("subagents-track-header").click();
      await expect(page.getByTestId(`subagents-track-row-facts-${child.id}`)).toHaveText(
        "Ten second stream · Low · Load test",
      );
      await tapSheetBackdrop(page);
    });

    await test.step("a subagent opens in place of the subagents list", async () => {
      await openSubagentFromCompactTrack(page, child.id);

      const childSheet = sheet(page, child.title);
      await expect(childSheet).toBeVisible();
      await expectSheetAtSnap(page, child.title);
      await expectSubagentRowGone(page, child.id);
      await expectOneSheetOpen(page);
      await expect(childSheet.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
      // The composer's model, thinking, and mode stand in for it, resolved the same way. An idle
      // seeded agent has no context usage yet.
      await expect(childSheet.getByTestId("agent-pane-subtitle")).toHaveText(
        "Ten second stream · Low · Load test",
      );
      await expectOpenTabCount(page, 1);
    });

    await test.step("Back returns the sheet to the list", async () => {
      await backToList(page, child.title);
      await expectSubagentRowVisible(page, child.id);
      await expectOneSheetOpen(page);
    });

    await test.step("Close closes the list with the subagent", async () => {
      await page.getByTestId(`subagents-track-row-${child.id}`).click();
      await closeSheet(page, child.title);
      await expectSubagentRowGone(page, child.id);
      await expectNoSheetOpen(page);
    });

    await test.step("the parent box in a subagent's sheet closes it onto the parent", async () => {
      await openSubagentFromCompactTrack(page, child.id);
      const childSheet = sheet(page, child.title);
      await expectSheetAtSnap(page, child.title);
      await expect(childSheet.getByTestId("composer-parent-agent-pill")).toHaveCount(0);
      await childSheet.getByTestId("parent-agent-callout-open").click();
      await expect(childSheet).toHaveCount(0);
      await expectNoSheetOpen(page);
      await expectOpenTabCount(page, 1);
    });

    await test.step("a nested subagent's parent box lands on its parent's sheet", async () => {
      await openSubagentFromCompactTrack(page, child.id);
      const childSheet = sheet(page, child.title);
      await openSubagentFromCompactTrack(page, grandchild.id, childSheet);
      const grandchildSheet = sheet(page, grandchild.title);
      await expectSheetAtSnap(page, grandchild.title);
      await expect(grandchildSheet.getByTestId("parent-agent-callout")).toContainText(child.title);

      await grandchildSheet.getByTestId("parent-agent-callout-open").click();
      await expect(grandchildSheet).toHaveCount(0);
      await expect(childSheet).toBeVisible();
      await expectOneSheetOpen(page);

      await childSheet.getByTestId("parent-agent-callout-open").click();
      await expect(childSheet).toHaveCount(0);
      await expectNoSheetOpen(page);
      await expectOpenTabCount(page, 1);
    });

    await test.step("Open as tab promotes the subagent to a full tab and ends the list", async () => {
      await openSubagentFromCompactTrack(page, child.id);
      await expectSheetAtSnap(page, child.title);
      await openSheetAsTab(page, child.title);
      await expect(page.getByTestId(`subagents-track-row-${child.id}`)).toHaveCount(0);
      await expectOpenTabCount(page, 2);
      await expectComposerVisible(page);
    });

    await test.step("the list the subagent was opened from closed with its tab", async () => {
      await selectTabFromSwitcher(page, "Sheet parent");
      await expect(page.getByTestId(`subagents-track-row-${child.id}`)).toHaveCount(0);
    });

    await test.step("once its tab closes, the subagent reopens in place of the list", async () => {
      await page
        .getByRole("button", { name: /Switch tabs/ })
        .filter({ visible: true })
        .click();
      await expect(page.getByText("Workspace tabs", { exact: true })).toBeVisible();
      const menuBase = `workspace-tab-menu-agent_${child.id}`;
      await page.getByTestId(`${menuBase}-trigger`).click();
      await page.getByTestId(`${menuBase}-close`).click();
      await expectOpenTabCount(page, 1);
      // Closing a tab keeps the switcher open, with the parent as the tab left. Its backdrop is
      // tapped once the row menu's own sheet has gone.
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(1);
      await tapSheetBackdrop(page);
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);

      await openSubagentFromCompactTrack(page, child.id);
      await expectSheetAtSnap(page, child.title);
      await backToList(page, child.title);
      await expectSubagentRowVisible(page, child.id);
      await tapSheetBackdrop(page);
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
    });

    await test.step("a sheet with unsaved edits closes only through the guarded close", async () => {
      await page.getByText(FILE_LINK, { exact: true }).click();
      const fileSheet = sheet(page, "linked.ts");
      await expect(fileSheet).toBeVisible();
      // Hold the autosave so the edit stays unsaved.
      gate.holdNextClientRequest("fs.file.write.request");
      await replaceSheetFileText(page, "linked.ts", "edited in the sheet");
      await gate.waitForHeldClientRequest();

      await expectDeclinedDiscardPrompt(page, () => tapSheetBackdrop(page));
      await expect(fileSheet.locator(".cm-content")).toHaveText("edited in the sheet");
      await expectDeclinedDiscardPrompt(page, () =>
        sheetHeader(page, "linked.ts").getByRole("button", { name: "Close" }).click(),
      );
      await expect(fileSheet.locator(".cm-content")).toHaveText("edited in the sheet");

      gate.releaseHeldClientRequest();
      await expect.poll(() => readFile(linkedPath, "utf8")).toBe("edited in the sheet");
    });
  } finally {
    await workspace.cleanup();
  }
});
