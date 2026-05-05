import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import { connectTerminalClient, type TerminalPerfDaemonClient } from "./terminal-perf";
import { connectWorkspaceSetupClient, openHomeWithProject } from "./workspace-setup";
import { selectWorkspaceInSidebar } from "./sidebar";
import { waitForTabBar } from "./launcher";

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
  await expect(composerInput(page)).toBeDisabled({ timeout: 10_000 });
}

export async function expectComposerDraft(page: Page, text: string): Promise<void> {
  await expect(composerInput(page)).toHaveValue(text, { timeout: 5_000 });
}

export async function expectComposerEditable(page: Page): Promise<void> {
  await expect(composerInput(page)).toBeEditable({ timeout: 15_000 });
}

export async function submitMessage(page: Page, text: string): Promise<void> {
  const input = composerInput(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

export async function fillComposerDraft(page: Page, text: string): Promise<void> {
  await composerInput(page).fill(text);
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
  await expect(page.getByTestId("message-input-attachment-menu")).toBeVisible({ timeout: 5_000 });
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
  const pill = page.getByTestId("composer-github-attachment-pill").first();
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

/** Open picker, type a query, wait for the matching option by id (e.g. "issue:3", "pr:1"), and click it. */
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
  client: TerminalPerfDaemonClient;
  repo: Awaited<ReturnType<typeof createTempGitRepo>>;
}

/** Create a temp repo, start a mock agent, navigate to it, and wait for it to be running. */
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

export interface GithubWorkspaceHandle {
  cleanup: () => Promise<void>;
}

/** Open a workspace backed by an existing repo path (e.g. a cloned GitHub repo). */
export async function openGithubWorkspace(
  page: Page,
  repoPath: string,
): Promise<GithubWorkspaceHandle> {
  const client = await connectWorkspaceSetupClient();
  const opened = await client.openProject(repoPath);
  if (!opened.workspace) throw new Error(opened.error ?? `Failed to open project ${repoPath}`);
  await openHomeWithProject(page, repoPath);
  await selectWorkspaceInSidebar(page, opened.workspace.id);
  await waitForTabBar(page);
  return { cleanup: () => client.close().catch(() => undefined) };
}
