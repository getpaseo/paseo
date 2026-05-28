import { expect, test } from "./fixtures";
import { clickNewChat } from "./helpers/launcher";
import { expectComposerVisible } from "./helpers/composer";
import { expectAgentIdle } from "./helpers/agent-stream";
import {
  openAttachmentMenu,
  openGithubPickerFromMenu,
  attachImageFromMenu,
  expectAttachmentPill,
  removeAttachmentPill,
  openImageLightbox,
  closeImageLightbox,
  pressInterruptShortcut,
  expectComposerDraft,
  expectComposerDisabled,
  expectComposerEditable,
  expectAttachButtonDisabled,
  fillComposerDraft,
  sendDraftToQueue,
  expectQueuedMessageButton,
  startRunningMockAgent,
  selectGithubOption,
  expectGithubAttachmentPill,
  openGithubWorkspace,
} from "./helpers/composer";
import {
  connectNewWorkspaceDaemonClient,
  delayBrowserAgentCreatedStatus,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { gotoAppShell } from "./helpers/app";
import { waitForSidebarHydration, switchWorkspaceViaSidebar } from "./helpers/workspace-ui";
import { createTempGitRepo } from "./helpers/workspace";
import { hasGithubAuth, createTempGithubRepo } from "./helpers/github-fixtures";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const TEST_IMAGE = { name: "test.png", mimeType: "image/png", buffer: MINIMAL_PNG };

test.describe("Composer attachments", () => {
  test("Plus menu shows image and GitHub options", async ({ page, withWorkspace }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-plus-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await openAttachmentMenu(page);

    await expect(page.getByTestId("message-input-attachment-menu-item-image")).toBeVisible();
    await expect(page.getByTestId("message-input-attachment-menu-item-github")).toBeVisible();
  });

  test("GitHub combobox does not render until the picker is opened", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-gh-lazy-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await expect(page.getByTestId("combobox-desktop-container")).not.toBeVisible();

    await openGithubPickerFromMenu(page);

    await expect(page.getByPlaceholder("Search issues and PRs...")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByTestId("combobox-empty-text").or(page.getByText("Searching...")),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("GitHub issue attachment pill visible after search and selection", async ({ page }) => {
    test.setTimeout(120_000);
    if (!hasGithubAuth()) {
      test.skip(true, "GitHub auth not available in this environment");
    }

    const ghRepo = await createTempGithubRepo({
      category: "attach-issue",
      issues: [{ title: "fix: attach-issue-unique-alpha" }],
      prs: [{ title: "feat: attach-issue-dummy-pr", state: "open" }],
    });
    const handle = await openGithubWorkspace(page, ghRepo.prs[0].localPath);
    try {
      await clickNewChat(page);
      await expectComposerVisible(page);

      await selectGithubOption(
        page,
        "attach-issue-unique-alpha",
        `issue:${ghRepo.issues[0].number}`,
      );

      await expectGithubAttachmentPill(page, {
        number: ghRepo.issues[0].number,
        title: ghRepo.issues[0].title,
      });
    } finally {
      await handle.cleanup();
      await ghRepo.cleanup();
    }
  });

  test("GitHub PR attachment pill visible after search and selection", async ({ page }) => {
    test.setTimeout(120_000);
    if (!hasGithubAuth()) {
      test.skip(true, "GitHub auth not available in this environment");
    }

    const ghRepo = await createTempGithubRepo({
      category: "attach-pr",
      prs: [{ title: "feat: attach-pr-unique-beta", state: "open" }],
    });
    const handle = await openGithubWorkspace(page, ghRepo.prs[0].localPath);
    try {
      await clickNewChat(page);
      await expectComposerVisible(page);

      await selectGithubOption(page, "attach-pr-unique-beta", `pr:${ghRepo.prs[0].number}`);

      await expectGithubAttachmentPill(page, {
        number: ghRepo.prs[0].number,
        title: ghRepo.prs[0].title,
      });
    } finally {
      await handle.cleanup();
      await ghRepo.cleanup();
    }
  });

  test.fixme("workspace-review pill suppresses on X-click and reappears after send", async () => {
    // The review attachment is created via InlineReviewEditor in surface.tsx (addComment action).
    // Automating this requires: a workspace with staged changes, navigating to the diff panel,
    // hovering the gutter "+" button, typing a comment, and submitting. A dedicated
    // helpers/review.ts with addInlineReviewComment(page, filePath, lineNumber, comment) is
    // needed before this can be exercised end-to-end.
  });

  test.fixme("browser-element attachment pill is created from Electron webview selection", async () => {
    // The browser-element attachment is only created in browser-pane.electron.tsx via DOM
    // element selection in the Electron webview. It is not exercisable in headless Chromium E2E.
  });

  test("image lightbox opens on pill click and closes on Escape", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-lightbox-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await attachImageFromMenu(page, TEST_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");

    await openImageLightbox(page);
    await closeImageLightbox(page);
  });

  test("image attachment pill renders after file is selected", async ({ page, withWorkspace }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-pill-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await attachImageFromMenu(page, TEST_IMAGE);

    await expectAttachmentPill(page, "composer-image-attachment-pill");
  });

  test("clicking the X on an image pill removes it", async ({ page, withWorkspace }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-remove-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await attachImageFromMenu(page, TEST_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");

    await removeAttachmentPill(page, "composer-image-attachment-pill", "Remove image attachment");

    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("submitting while agent is running queues the message and clears the draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { client, repo } = await startRunningMockAgent(page, {
      prefix: "attach-queue-",
      model: "one-minute-stream",
      prompt: "Stay running for queue test.",
    });
    try {
      await fillComposerDraft(page, "queued draft text");
      await sendDraftToQueue(page);

      await expectQueuedMessageButton(page);
      await expectComposerDraft(page, "");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("Escape interrupt cancels the running agent and preserves composer draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { client, repo } = await startRunningMockAgent(page, {
      prefix: "attach-interrupt-",
      model: "ten-second-stream",
      prompt: "Stay running for interrupt test.",
    });
    try {
      await fillComposerDraft(page, "preserve me");
      await pressInterruptShortcut(page);

      await expectAgentIdle(page, 15_000);
      await expectComposerDraft(page, "preserve me");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("composer is locked while new workspace agent is being created", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("E2E_SERVER_ID is not set.");

    const repo = await createTempGitRepo("attach-lock-");
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);
    const daemonClient = await connectNewWorkspaceDaemonClient();

    try {
      const openedProject = await openProjectViaDaemon(daemonClient, repo.path);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: openedProject.workspaceId,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await fillComposerDraft(page, "lock test prompt");
      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      await expectComposerDisabled(page);
      await expectAttachButtonDisabled(page);

      agentCreatedDelay.release();

      await expectComposerEditable(page);
    } finally {
      agentCreatedDelay.release();
      await daemonClient.close().catch(() => undefined);
      await repo.cleanup();
    }
  });
});
