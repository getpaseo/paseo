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
  startRunningMockAgent,
} from "./helpers/composer-attachments";

/** Minimal 1×1 transparent PNG — just enough for the image-picker to accept. */
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

  test("GitHub combobox opens and search fires only after the picker is opened", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "attach-gh-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    await expect(page.getByTestId("combobox-desktop-container")).not.toBeVisible();

    await openGithubPickerFromMenu(page);

    await expect(page.getByPlaceholder("Search issues and PRs...")).toBeVisible({ timeout: 5_000 });

    // In the test env GitHub search returns no real results, so either loading or
    // empty state proves the query ran (enabled=true only once the picker is open).
    await expect(
      page.getByTestId("combobox-empty-text").or(page.getByText("Searching...")),
    ).toBeVisible({ timeout: 10_000 });
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
      // Ctrl+Enter triggers the alternate send action, which queues the message when
      // sendBehavior="interrupt" (default) and the agent is running.
      const input = page.getByRole("textbox", { name: "Message agent..." }).first();
      await input.fill("queued draft text");
      await input.press("Control+Enter");

      await expect(page.getByRole("button", { name: "Send queued message now" })).toBeVisible({
        timeout: 10_000,
      });
      await expectComposerDraft(page, "");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test.fixme("workspace-review pill suppresses on X-click and reappears after send", async () => {
    // The Zustand store is exposed on window.__paseoWorkspaceAttachmentsStore in E2E mode
    // (workspace-attachments-store.ts). Steps once a seeding helper exists:
    //   1. Navigate to workspace + new chat
    //   2. Build scope key via buildWorkspaceAttachmentScopeKey({ serverId, cwd })
    //   3. Call store.getState().setWorkspaceAttachments({ scopeKey, attachments: [reviewAttachment] })
    //   4. Assert "composer-review-attachment-pill" is visible
    //   5. Click "Remove review attachment" to suppress it
    //   6. Assert pill is gone
    //   7. Submit any message (triggers completeSubmit → resetSuppression)
    //   8. Assert pill reappears
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
      // Type draft text that should survive the interrupt.
      const draftText = "preserve me";
      const input = page.getByRole("textbox", { name: "Message agent..." }).first();
      await input.click();
      await input.fill(draftText);

      // Escape fires the "agent.interrupt" keyboard shortcut (keyboard-shortcuts.ts).
      await pressInterruptShortcut(page);

      await expectAgentIdle(page, 15_000);
      await expectComposerDraft(page, draftText);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
