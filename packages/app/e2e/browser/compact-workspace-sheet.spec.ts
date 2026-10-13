import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openSubagentFromCompactTrack, seedSubagent } from "../support/helpers/subagents";
import {
  closeWorkspaceSheet,
  expectOpenTabCount,
  openWorkspaceSheetAsTab,
  expectDeclinedDiscardPrompt,
  expectWorkspaceSheetAtSnap,
  replaceWorkspaceSheetFileText,
  selectTabFromSwitcher,
  tapWorkspaceSheetBackdrop,
  workspaceSheet,
} from "../support/helpers/workspace-sheet";

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
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: workspace.agentId });
    await expectOpenTabCount(page, 1);

    await test.step("a chat file link opens the file in a sheet", async () => {
      const fileLink = page.getByText(FILE_LINK, { exact: true });
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.click();

      const sheet = workspaceSheet(page, "linked.ts");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("three")).toBeVisible();
      await expectWorkspaceSheetAtSnap(page, "linked.ts");
      await expect(sheet.getByRole("button", { name: "Open as tab" })).toHaveCount(0);
      await expectOpenTabCount(page, 1);
      await closeWorkspaceSheet(page, "linked.ts");
    });

    await test.step("a subagent opens in a sheet without its composer", async () => {
      await openSubagentFromCompactTrack(page, child.id);

      const sheet = workspaceSheet(page, child.title);
      await expect(sheet).toBeVisible();
      await expectWorkspaceSheetAtSnap(page, child.title);
      await expect(sheet.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
      await expectOpenTabCount(page, 1);
    });

    await test.step("Open as tab promotes the subagent to a full tab", async () => {
      await openWorkspaceSheetAsTab(page, child.title);
      await expectOpenTabCount(page, 2);
      await expectComposerVisible(page);
    });

    await test.step("a sheet with unsaved edits closes only through the guarded close", async () => {
      await selectTabFromSwitcher(page, "Sheet parent");
      await page.getByText(FILE_LINK, { exact: true }).click();
      const sheet = workspaceSheet(page, "linked.ts");
      await expect(sheet).toBeVisible();
      // Hold the autosave so the edit stays unsaved.
      gate.holdNextClientRequest("fs.file.write.request");
      await replaceWorkspaceSheetFileText(page, "linked.ts", "edited in the sheet");
      await gate.waitForHeldClientRequest();

      await expectDeclinedDiscardPrompt(page, () => tapWorkspaceSheetBackdrop(page));
      await expect(sheet.locator(".cm-content")).toHaveText("edited in the sheet");
      await expectDeclinedDiscardPrompt(page, () =>
        sheet.getByRole("button", { name: "Close" }).click(),
      );
      await expect(sheet.locator(".cm-content")).toHaveText("edited in the sheet");

      gate.releaseHeldClientRequest();
      await expect.poll(() => readFile(linkedPath, "utf8")).toBe("edited in the sheet");
    });
  } finally {
    await workspace.cleanup();
  }
});
