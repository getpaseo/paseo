import { expect, test, type Page } from "./fixtures";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { connectTerminalClient } from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "./helpers/composer";

// UI plumbing contract against the dev mock provider. Real-provider behavior is tested in `daemon-e2e/*-rewind.real.e2e.test.ts`.

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function openAgent(page: Page, input: { cwd: string; agentId: string }): Promise<void> {
  const agentUrl = `${buildHostWorkspaceRoute(
    getServerId(),
    input.cwd,
  )}?open=${encodeURIComponent(`agent:${input.agentId}`)}`;
  await page.goto(agentUrl);
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await expectComposerVisible(page);
}

async function expectUserMessageCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId("user-message")).toHaveCount(expected);
}

test.describe("Rewind sheet", () => {
  test("rewinds from a user message sheet option", async ({ page }) => {
    const repo = await createTempGitRepo("rewind-e2e-");
    const client = await connectTerminalClient();
    const firstPrompt = "emit 1 coalesced agent stream updates for first rewind turn.";
    const secondPrompt = "Prepare deleted rewind turn assistant content.";
    const replacementPrompt = "emit 1 coalesced agent stream updates for replacement rewind turn.";

    try {
      await client.openProject(repo.path);
      const agent = await client.createAgent({
        provider: "mock",
        cwd: repo.path,
        title: "Rewind e2e",
        modeId: "load-test",
        model: "ten-second-stream",
        initialPrompt: firstPrompt,
      });
      await openAgent(page, { cwd: repo.path, agentId: agent.id });

      await expect(page.getByText(firstPrompt, { exact: true })).toBeVisible();
      await expectUserMessageCount(page, 1);
      await submitMessage(page, secondPrompt);
      await expect(page.getByText(secondPrompt, { exact: true })).toBeVisible();
      await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
      await expectUserMessageCount(page, 2);

      await page.getByText(firstPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(rewindSheet.getByText("Rewind to this message", { exact: true })).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expect(page.getByText(secondPrompt, { exact: true })).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 1);
      await expectComposerDraft(page, firstPrompt);

      await submitMessage(page, replacementPrompt);
      await expect(page.getByText(replacementPrompt, { exact: true })).toBeVisible();
      await expect(page.getByText(secondPrompt, { exact: true })).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await page.getByText(replacementPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, "");
      await expectUserMessageCount(page, 2);

      const preservedDraft = "Keep this human draft after rewind.";
      await fillComposerDraft(page, preservedDraft);
      await composerLocator(page).evaluate((element) => element.blur());
      await page.getByText(replacementPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, preservedDraft);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await page.getByText(replacementPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-both").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, replacementPrompt);
      await expectUserMessageCount(page, 1);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("surfaces rewind failures without crashing the page", async ({ page }) => {
    const repo = await createTempGitRepo("rewind-failure-e2e-");
    const client = await connectTerminalClient();
    const firstPrompt = "emit 1 coalesced agent stream updates for failed rewind turn.";
    const rewindError = "No file checkpoint found for message rewind-failure-e2e.";

    try {
      await client.openProject(repo.path);
      const agent = await client.createAgent({
        provider: "mock",
        cwd: repo.path,
        title: "Rewind failure e2e",
        modeId: "load-test",
        model: "ten-second-stream",
        featureValues: {
          mockRewindError: rewindError,
        },
        initialPrompt: firstPrompt,
      });
      await openAgent(page, { cwd: repo.path, agentId: agent.id });

      await expect(page.getByText(firstPrompt, { exact: true })).toBeVisible();

      await page.getByText(firstPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(rewindSheet.getByText("Rewind to this message", { exact: true })).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("app-toast-message")).toHaveText(rewindError);
      await expect(page.getByText("Uncaught Error")).toHaveCount(0);

      await page.getByText(firstPrompt, { exact: true }).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
