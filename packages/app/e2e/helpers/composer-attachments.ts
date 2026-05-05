import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import { connectTerminalClient, type TerminalPerfDaemonClient } from "./terminal-perf";
import { expectComposerVisible } from "./composer";

/** Click the Plus attachment button and wait for the menu to appear. */
export async function openAttachmentMenu(page: Page): Promise<void> {
  await page.getByTestId("message-input-attach-button").filter({ visible: true }).first().click();
  await expect(page.getByTestId("message-input-attachment-menu")).toBeVisible({ timeout: 5_000 });
}

/** Open the Plus menu and click "Add issue or PR" to reveal the GitHub combobox. */
export async function openGithubPickerFromMenu(page: Page): Promise<void> {
  await openAttachmentMenu(page);
  await page.getByTestId("message-input-attachment-menu-item-github").click();
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 5_000 });
}

/**
 * Open the Plus menu, click "Add image", intercept the file chooser, and
 * supply the given file. expo-image-picker on web triggers a hidden
 * <input type="file"> which Playwright captures as a filechooser event.
 */
export async function attachImageFromMenu(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await openAttachmentMenu(page);
  await page.getByTestId("message-input-attachment-menu-item-image").click();
  const chooser = await chooserPromise;
  await chooser.setFiles([file]);
}

/** Assert an attachment pill is visible by its testID. */
export async function expectAttachmentPill(page: Page, testID: string): Promise<void> {
  await expect(page.getByTestId(testID).first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Hover a pill to reveal the X button (opacity:0/pointerEvents:none until hover on
 * desktop web), then click remove by its accessible label.
 */
export async function removeAttachmentPill(
  page: Page,
  pillTestId: string,
  removeAccessibilityLabel: string,
): Promise<void> {
  await page.getByTestId(pillTestId).first().hover();
  await page.getByRole("button", { name: removeAccessibilityLabel }).first().click();
}

/** Click an image pill to open the lightbox and wait for it to be visible. */
export async function openImageLightbox(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open image attachment" }).first().click();
  await expect(page.getByTestId("attachment-lightbox-close")).toBeVisible({ timeout: 5_000 });
}

/** Close the lightbox with the Escape key and wait for it to disappear. */
export async function closeImageLightbox(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attachment-lightbox-close")).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Press the agent interrupt shortcut.
 * The app binds "agent.interrupt" to Escape (keyboard-shortcuts.ts, id: "agent-interrupt",
 * combo: "Escape"), fired when commandCenter=false and terminal=false.
 */
export async function pressInterruptShortcut(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

/**
 * Assert the composer input is non-editable and the attach button is disabled.
 * This state arises when the parent passes isSubmitLoading=true to Composer
 * (e.g. workspace-draft-agent-tab during agent creation).
 */
export async function expectComposerLocked(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).not.toBeEditable({
    timeout: 5_000,
  });
  // The DropdownMenuTrigger renders aria-disabled when disabled={true}.
  await expect(page.getByTestId("message-input-attach-button")).toBeDisabled({ timeout: 5_000 });
}

/** Assert the composer textarea contains the expected text. */
export async function expectComposerDraft(page: Page, text: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue(text, {
    timeout: 5_000,
  });
}

export interface MockAgentSetup {
  client: TerminalPerfDaemonClient;
  repo: Awaited<ReturnType<typeof createTempGitRepo>>;
}

/**
 * Create a temp git repo, start a mock agent, navigate to it, and wait for
 * the agent to be visibly running. Returns client and repo for cleanup in a
 * finally block.
 */
export async function startRunningMockAgent(
  page: Page,
  opts: { prefix: string; model: string; prompt: string },
): Promise<MockAgentSetup> {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) throw new Error("E2E_SERVER_ID is not set.");

  const repo = await createTempGitRepo(opts.prefix);
  const client = await connectTerminalClient();
  const opened = await client.openProject(repo.path);
  if (!opened.workspace) throw new Error(opened.error ?? "Failed to open project");
  const agent = await client.createAgent({
    provider: "mock",
    cwd: repo.path,
    model: opts.model,
    initialPrompt: opts.prompt,
  });
  const agentUrl = `${buildHostWorkspaceRoute(serverId, repo.path)}?open=${encodeURIComponent(`agent:${agent.id}`)}`;
  await page.goto(agentUrl);
  await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expectComposerVisible(page);
  return { client, repo };
}
