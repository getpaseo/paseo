import { expect, test } from "../support/fixtures";
import { clickNewChat } from "../support/helpers/launcher";
import { expectComposerVisible } from "../support/helpers/composer";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  openAttachmentMenu,
  expectAttachmentSheetRowsOnTitleRail,
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
  dropFileOnComposer,
  sendDraftToQueue,
  expectQueuedMessageButton,
  startRunningMockAgent,
  selectGithubOption,
  expectGithubAttachmentPill,
  openGithubWorkspace,
} from "../support/helpers/composer";
import {
  delayBrowserAgentCreatedStatus,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { gotoAppShell } from "../support/helpers/app";
import {
  waitForSidebarHydration,
  switchWorkspaceViaSidebar,
} from "../support/helpers/workspace-ui";
import { seedWorkspace } from "../support/helpers/seed-client";
import { hasGithubAuth, createTempGithubRepo } from "../support/helpers/github-fixtures";
import { getServerId } from "../support/helpers/server-id";
import { openFileExplorer } from "../support/helpers/file-explorer";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const TEST_IMAGE = { name: "test.png", mimeType: "image/png", buffer: MINIMAL_PNG };
const TEST_JSON = {
  name: "config.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "drop" })),
};

test.describe("Composer attachments", () => {
  test("compact Plus menu aligns attachment rows with its sheet title", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-sheet-rails-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await openAttachmentMenu(page);

    await expectAttachmentSheetRowsOnTitleRail(page);
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

  test("attaches an issue and a pull request from the repository picker", async ({ page }) => {
    test.setTimeout(120_000);
    if (!hasGithubAuth()) {
      test.skip(true, "GitHub auth not available in this environment");
    }
    const ghRepo = await createTempGithubRepo({
      category: "attachments",
      issues: [{ title: "fix: attachment issue" }],
      prs: [{ title: "feat: attachment pull request", state: "open" }],
    });
    const handle = await openGithubWorkspace(page, ghRepo.prs[0].localPath);
    try {
      await clickNewChat(page);
      await expectComposerVisible(page);
      // Choose from the repository list. Newly created repositories are not
      // necessarily available in GitHub's separate text-search index yet.
      await selectGithubOption(page, "", `issue:${ghRepo.issues[0].number}`);
      await expectGithubAttachmentPill(page, ghRepo.issues[0]);
      await selectGithubOption(page, "", `change_request:${ghRepo.prs[0].number}`);
      await expectGithubAttachmentPill(page, ghRepo.prs[0]);
      await expectGithubAttachmentPill(page, ghRepo.issues[0]);
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

  test("attaches, previews, and removes an image before dropping a file", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-lightbox-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await test.step("open the available attachment choices", async () => {
      await openAttachmentMenu(page);
      await expect(page.getByTestId("message-input-attachment-menu-item-image")).toBeVisible();
      await expect(page.getByTestId("message-input-attachment-menu-item-github")).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await attachImageFromMenu(page, TEST_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");

    await openImageLightbox(page);
    await closeImageLightbox(page);

    await test.step("remove the image and attach a dropped file", async () => {
      await removeAttachmentPill(page, "composer-image-attachment-pill", "Remove image attachment");
      await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
      await dropFileOnComposer(page, TEST_JSON);
      await expectAttachmentPill(page, "composer-file-attachment-pill");
    });
  });

  test("dropped JSON file renders as a file attachment in New Workspace", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "attach-drop-new-workspace-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: workspace.workspaceId,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await dropFileOnComposer(page, TEST_JSON);

      await expectAttachmentPill(page, "composer-file-attachment-pill");
    } finally {
      await workspace.cleanup();
    }
  });

  test("submitting while agent is running queues the message and clears the draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
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
      await agent.cleanup();
    }
  });

  test("Escape interrupt cancels the running agent and preserves composer draft", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
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
      await agent.cleanup();
    }
  });

  test("Escape cancels file creation without interrupting the running agent", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "file-create-escape-",
      model: "one-minute-stream",
      prompt: "Stay running while a file draft is cancelled.",
    });
    try {
      await openFileExplorer(page);
      await page.getByTestId("files-new-file").click();
      const nameInput = page.getByTestId("file-explorer-name-input");
      await expect(nameInput).toBeVisible();

      await nameInput.press("Escape");

      await expect(nameInput).toBeHidden();
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("composer is locked while new workspace agent is being created", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();

    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);
    const workspace = await seedWorkspace({ repoPrefix: "attach-lock-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: workspace.workspaceId,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
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
      await workspace.cleanup();
    }
  });
});
