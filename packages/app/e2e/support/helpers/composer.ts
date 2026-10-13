import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import { connectSeedClient, type SeedDaemonClient } from "./seed-client";
import { gotoAppShell } from "./app";
import { connectWorkspaceSetupClient } from "./workspace-setup";
import { selectWorkspaceInSidebar } from "./sidebar";
import { getServerId } from "./server-id";
import { waitForTabBar } from "./launcher";
import { waitForSettledPosition } from "./sheet-layout";
import { installDaemonWebSocketGate } from "./daemon-websocket-gate";

export async function controlFileUploadCompletion(page: Page) {
  const gate = await installDaemonWebSocketGate(page);
  return {
    hold: () => gate.holdNextServerMessage("file.upload.response"),
    waitForUpload: () => gate.waitForHeldServerMessage("file.upload.response"),
    complete: () => gate.releaseHeldServerMessage("file.upload.response"),
  };
}

function composerInput(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." }).first();
}

export function composerLocator(page: Page) {
  return composerInput(page);
}

export async function expectComposerVisible(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(composerInput(page)).toBeVisible({ timeout: options?.timeout ?? 15_000 });
}

export async function expectComposerDisabled(page: Page): Promise<void> {
  // React Native TextInput with editable={false} renders as <textarea readonly> on web,
  // not <textarea disabled>. Use not.toBeEditable() to match either form.
  await expect(composerInput(page)).not.toBeEditable({ timeout: 10_000 });
}

export async function expectComposerDraft(page: Page, text: string): Promise<void> {
  await expect(composerInput(page)).toHaveValue(text, { timeout: 5_000 });
}

export async function expectComposerEditable(page: Page): Promise<void> {
  await expect(composerInput(page)).toBeEditable({ timeout: 15_000 });
}

export async function expectComposerFocused(page: Page): Promise<void> {
  await expect(composerInput(page)).toBeFocused();
}

export async function expectComposerNotFocused(page: Page): Promise<void> {
  await expect(composerInput(page)).not.toBeFocused();
}

export async function submitMessage(page: Page, text: string): Promise<void> {
  const input = composerInput(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

/** The Send button works on compact screens, where Enter inserts a newline. */
export async function submitMessageWithButton(page: Page, text: string): Promise<void> {
  await fillComposerDraft(page, text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

export async function fillComposerDraft(page: Page, text: string): Promise<void> {
  await composerInput(page).fill(text);
}

export async function typeIntoFocusedComposer(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
}

export async function sendDraftToQueue(page: Page): Promise<void> {
  await composerInput(page).press("Control+Enter");
}

export async function expectQueuedMessageButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Send queued message now" })).toBeVisible({
    timeout: 10_000,
  });
}

export async function cancelAgent(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: /stop|cancel/i }).first();
  await expect(stopButton).toBeVisible({ timeout: 10_000 });
  await stopButton.click();
}

/** Escape is bound to the "agent.interrupt" keyboard shortcut. */
export async function pressInterruptShortcut(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

export async function openAttachmentMenu(page: Page): Promise<void> {
  await page.getByTestId("message-input-attach-button").filter({ visible: true }).first().click();
  await expect(
    page
      .getByTestId("message-input-attachment-menu")
      .or(page.getByTestId("message-input-attachment-menu-content")),
  ).toBeVisible({ timeout: 5_000 });
}

export async function expectAttachmentSheetRowsOnTitleRail(page: Page): Promise<void> {
  const title = page.getByText("Add attachment", { exact: true });
  const firstItemGlyph = page
    .getByRole("menuitem", { name: "Add image", exact: true })
    .locator("svg")
    .first();
  await waitForSettledPosition(title);
  const [titleBox, glyphBox] = await Promise.all([
    title.boundingBox(),
    firstItemGlyph.boundingBox(),
  ]);
  if (!titleBox || !glyphBox) {
    throw new Error("Attachment sheet geometry could not be measured");
  }
  expect(Math.abs(glyphBox.x - titleBox.x)).toBeLessThanOrEqual(1);
}

export async function expectAttachButtonDisabled(page: Page): Promise<void> {
  await expect(
    page.getByTestId("message-input-attach-button").filter({ visible: true }).first(),
  ).toBeDisabled({ timeout: 10_000 });
}

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

export async function expectAttachmentPill(page: Page, testID: string): Promise<void> {
  await expect(page.getByTestId(testID).first()).toBeVisible({ timeout: 10_000 });
}

export async function attachFileFromMenu(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await openAttachmentMenu(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload file", exact: true }).click();
  await (await chooserPromise).setFiles(file);
}

export async function dropFileOnComposer(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ name, mimeType, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const droppedFile = new File([bytes], name, { type: mimeType });
      const transfer = new DataTransfer();
      transfer.items.add(droppedFile);
      return transfer;
    },
    {
      name: file.name,
      mimeType: file.mimeType,
      base64: file.buffer.toString("base64"),
    },
  );

  const composerRoot = page.getByTestId("message-input-root").filter({ visible: true }).first();
  await expect(composerRoot).toBeVisible({ timeout: 10_000 });
  await composerRoot.dispatchEvent("dragenter", { dataTransfer });
  await composerRoot.dispatchEvent("dragover", { dataTransfer });
  await composerRoot.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

/** Hover to reveal the X button (hidden until hover on desktop web), then click by accessible label. */
export async function removeAttachmentPill(
  page: Page,
  pillTestId: string,
  removeAccessibilityLabel: string,
): Promise<void> {
  await page.getByTestId(pillTestId).first().hover();
  await page.getByRole("button", { name: removeAccessibilityLabel }).first().click();
}

export async function expectGithubAttachmentPill(
  page: Page,
  input: { number: number; title: string },
): Promise<void> {
  const pill = page.getByTestId("composer-github-attachment-pill").filter({ hasText: input.title });
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await expect(pill).toContainText(`#${input.number}`);
  await expect(pill).toContainText(input.title);
}

export async function openImageLightbox(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open image attachment" }).first().click();
  await expect(page.getByTestId("attachment-lightbox-close")).toBeVisible({ timeout: 5_000 });
}

export async function closeImageLightbox(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attachment-lightbox-close")).not.toBeVisible({ timeout: 5_000 });
}

export async function openGithubPickerFromMenu(page: Page): Promise<void> {
  await openAttachmentMenu(page);
  await page.getByTestId("message-input-attachment-menu-item-github").click();
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 5_000 });
}

/** Open picker, type a query, wait for the matching option by id (e.g. "issue:3", "change_request:1"), and click it. */
export async function selectGithubOption(
  page: Page,
  searchTerm: string,
  optionId: string,
): Promise<void> {
  await openGithubPickerFromMenu(page);
  const searchInput = page.getByPlaceholder("Search issues and PRs...");
  await expect(searchInput).toBeVisible({ timeout: 5_000 });
  await searchInput.fill(searchTerm);
  const option = page.getByTestId(`composer-github-option-${optionId}`);
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
}

export interface MockAgentSetup {
  client: SeedDaemonClient;
  repo: Awaited<ReturnType<typeof createTempGitRepo>>;
  workspaceId: string;
  agentId: string;
  cleanup: () => Promise<void>;
}

/** Create a temp repo, start a mock agent, navigate to it, and wait for it to be running. */
export async function startRunningMockAgent(
  page: Page,
  opts: {
    prefix: string;
    model: string;
    prompt: string;
    featureValues?: Record<string, unknown>;
  },
): Promise<MockAgentSetup> {
  const serverId = getServerId();

  const repo = await createTempGitRepo(opts.prefix);
  const client = await connectSeedClient();
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? "Failed to create workspace");
  }
  const workspace = createdWorkspace.workspace;
  const agent = await client.createAgent({
    provider: "mock",
    cwd: repo.path,
    workspaceId: workspace.id,
    model: opts.model,
    featureValues: opts.featureValues,
  });
  const agentUrl = `${buildHostWorkspaceRoute(serverId, workspace.id)}?open=${encodeURIComponent(`agent:${agent.id}`)}`;
  await page.goto(agentUrl);
  await expectComposerVisible(page);
  await client.sendAgentMessage(agent.id, opts.prompt);
  await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
    timeout: 30_000,
  });
  return {
    client,
    repo,
    workspaceId: workspace.id,
    agentId: agent.id,
    cleanup: async () => {
      await client.removeProject(workspace.projectId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  };
}

export interface GithubWorkspaceHandle {
  cleanup: () => Promise<void>;
}

/** Open a workspace backed by an existing repo path (e.g. a cloned GitHub repo). */
export async function openGithubWorkspace(
  page: Page,
  repoPath: string,
): Promise<GithubWorkspaceHandle> {
  const client = await connectWorkspaceSetupClient();
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repoPath },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repoPath}`);
  }
  const workspace = createdWorkspace.workspace;
  await gotoAppShell(page);
  await selectWorkspaceInSidebar(page, workspace.id);
  await waitForTabBar(page);
  return {
    cleanup: async () => {
      await client.removeProject(workspace.projectId).catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

const COMPOSER_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function attachComposerTestImage(page: Page): Promise<void> {
  await attachImageFromMenu(page, {
    name: "fullscreen.png",
    mimeType: "image/png",
    buffer: Buffer.from(COMPOSER_TEST_IMAGE_BASE64, "base64"),
  });
}

export async function pasteComposerTestImage(page: Page): Promise<boolean> {
  return composerInput(page).evaluate((input, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }, COMPOSER_TEST_IMAGE_BASE64);
}

export async function enterComposerFullscreen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
}
export async function exitComposerFullscreen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
}
export async function resizeComposerViewport(
  page: Page,
  orientation: "portrait" | "landscape" | "short",
): Promise<void> {
  const sizes = {
    portrait: { width: 390, height: 844 },
    landscape: { width: 844, height: 390 },
    short: { width: 390, height: 390 },
  };
  await page.setViewportSize(sizes[orientation]);
}
export async function selectComposerDraftRange(
  page: Page,
  start: number,
  end: number,
): Promise<void> {
  await composerInput(page).focus();
  await composerInput(page).evaluate(
    (element, selection) => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(selection.start, selection.end);
      input.dispatchEvent(new Event("select", { bubbles: true }));
    },
    { start, end },
  );
}
export async function expectComposerDraftSelection(
  page: Page,
  start: number,
  end: number,
): Promise<void> {
  await expect
    .poll(() =>
      composerInput(page).evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return [input.selectionStart, input.selectionEnd];
      }),
    )
    .toEqual([start, end]);
}
export async function expectComposerFullscreenControls(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await expect(page.getByTestId("composer-fullscreen").getByRole("button")).toHaveCount(2);
  await expect(composerInput(page)).toHaveCount(1);
}
export async function sendComposerWithButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
export async function queueComposerWithButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
}
export async function configureComposerQueueSend(page: Page): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ sendBehavior: "queue" })),
  );
}

/** Drive the real tab chooser's commands even when fullscreen covers its pointer surface.
 * This exercises retained activity changes, not a claim that covered chrome is clickable.
 */
export async function activateRetainedComposerTab(page: Page, title: string): Promise<void> {
  await page
    .getByTestId("workspace-tab-switcher-trigger")
    .evaluate((element) => (element as HTMLElement).click());
  const option = page.getByText(title, { exact: true }).filter({ visible: true }).last();
  await expect(option).toBeVisible();
  await option.evaluate((element) => (element as HTMLElement).click());
}

export async function recordVisibleComposerGeometry(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: { input: number; root: number }[] = [];
    Reflect.set(window, "__composerGeometryFrames", frames);
    let running = true;
    const tick = () => {
      if (!running) return;
      for (const root of document.querySelectorAll('[data-testid="message-input-root"]')) {
        if (root.getClientRects().length === 0) continue;
        const input = root.querySelector("textarea");
        if (input)
          frames.push({
            input: input.getBoundingClientRect().height,
            root: root.getBoundingClientRect().height,
          });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Reflect.set(window, "__stopComposerGeometry", () => {
      running = false;
    });
  });
}
export async function expectNoCollapsedVisibleComposer(page: Page): Promise<void> {
  const frames = await page.evaluate(() => {
    Reflect.get(window, "__stopComposerGeometry")?.();
    return Reflect.get(window, "__composerGeometryFrames") as { input: number; root: number }[];
  });
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.root < 42 || frame.input < 42)).toEqual([]);
}
