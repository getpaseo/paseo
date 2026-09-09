import { test, expect, type Page } from "../support/fixtures";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";

function terminalTab(page: Page, terminalId: string) {
  // Terminal tab chips have no tab role; their persistent identity survives title loading.
  return page.getByTestId(`workspace-tab-terminal_${terminalId}`).filter({ visible: true }).first();
}

async function createNamedTerminal(page: Page, workspace: SeededWorkspace, title: string) {
  await gotoWorkspace(page, workspace.workspaceId);
  await clickNewTerminal(page);
  const list = () =>
    workspace.client.listTerminals(workspace.repoPath, undefined, {
      workspaceId: workspace.workspaceId,
    });
  await expect.poll(async () => (await list()).terminals.length).toBe(1);
  const terminalId = (await list()).terminals[0]!.id;
  await terminalTab(page, terminalId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const modal = `workspace-tab-rename-modal-terminal-${terminalId}`;
  await renameModalInput(page, modal).fill(title);
  await renameModalSubmit(page, modal).click();
  await expect(renameModalInput(page, modal)).toHaveCount(0);
  await expect(terminalTab(page, terminalId)).toHaveText(title);
  return terminalId;
}

async function recordRestoredTabText(page: Page, terminalId: string) {
  // Install before the next document loads: a final-state assertion would miss the flash.
  await page.addInitScript((id) => {
    const samples: string[] = [];
    Object.assign(window, { terminalTitleSamples: samples });
    new MutationObserver(() => {
      const tab = document.querySelector(`[data-testid="workspace-tab-terminal_${id}"]`);
      if (!tab) return;
      const text = (tab.textContent ?? "").trim();
      if (samples.at(-1) !== text) samples.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, terminalId);
}

async function expectRestoredTitle(page: Page, terminalId: string, title: string, stage: string) {
  await expect(terminalTab(page, terminalId)).toHaveText(title, { timeout: 30_000 });
  const samples = await page.evaluate(
    () => (window as unknown as { terminalTitleSamples: string[] }).terminalTitleSamples,
  );
  await test.info().attach(`${stage}-tab-text`, {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  expect(samples).toContain(title);
  expect(samples).not.toContain("Terminal");
}

test("restored terminal titles do not flash a default name while loading", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "terminal-title-loading-", git: false });
  const other = await seedWorkspace({ repoPrefix: "terminal-title-other-", git: false });
  try {
    const title = "My named terminal";
    const terminalId = await createNamedTerminal(page, workspace, title);
    await recordRestoredTabText(page, terminalId);

    await test.step("reload with a terminal tab restored", async () => {
      await page.reload();
      await expectRestoredTitle(page, terminalId, title, "reload");
    });

    await test.step("first workspace visit in a fresh page session", async () => {
      await gotoWorkspace(page, other.workspaceId);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await expectRestoredTitle(page, terminalId, title, "first-visit");
    });

    await test.step("return to the workspace with its titles already loaded", async () => {
      await selectWorkspaceInSidebar(page, other.workspaceId);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await expectRestoredTitle(page, terminalId, title, "return-visit");
    });
  } finally {
    await workspace.cleanup();
    await other.cleanup();
  }
});
