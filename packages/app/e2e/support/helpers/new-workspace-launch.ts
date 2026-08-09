import { expect, type Page } from "@playwright/test";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { waitForTerminalContent } from "./terminal-perf";

export type { TerminalProfile };

export interface TerminalProfileSeed {
  /** Restores the daemon's terminalProfiles to what they were before seeding, and closes the client. */
  restore(): Promise<void>;
}

/**
 * Overrides the connected host's terminal profiles for the duration of a
 * test. The daemon has no "unset" for a patched config field, so restoring
 * writes back either the exact previous array, or the shipped defaults when
 * the host had never customized profiles — functionally identical to the
 * absent state `resolveTerminalProfiles` would otherwise produce.
 */
export async function seedTerminalProfiles(
  profiles: TerminalProfile[],
): Promise<TerminalProfileSeed> {
  const client = await connectNewWorkspaceDaemonClient();
  const previous = await client.getDaemonConfig();
  await client.patchDaemonConfig({ terminalProfiles: profiles });
  return {
    async restore() {
      await client.patchDaemonConfig({
        terminalProfiles: previous.config.terminalProfiles ?? [...DEFAULT_TERMINAL_PROFILES],
      });
      await client.close();
    },
  };
}

/** Mid-test profile changes (e.g. simulating a profile being removed). Does not manage restoration — pair with `seedTerminalProfiles` for that. */
export async function patchTerminalProfiles(profiles: TerminalProfile[]): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient();
  try {
    await client.patchDaemonConfig({ terminalProfiles: profiles });
  } finally {
    await client.close();
  }
}

// ─── Locators ──────────────────────────────────────────────────────────────

/** The single meta-row chip that chooses chat or a terminal. */
export function launchTrigger(page: Page) {
  return page.getByTestId("new-workspace-launch-trigger");
}

export function launchMenu(page: Page) {
  return page.getByTestId("new-workspace-launch-menu");
}

export function launchOption(page: Page, optionId: string) {
  return page.getByTestId(`new-workspace-launch-option-${optionId}`);
}

export function manageProfilesOption(page: Page) {
  return page.getByTestId("new-workspace-launch-manage-profiles");
}

// Chat and terminal are the same composer in two modes, so they share
// `message-input-root`. What tells them apart is which affordances that mode
// renders: chat has the attachment button, terminal has the Launch button.
export function composerRoot(page: Page) {
  return page.locator('[data-testid="message-input-root"]:visible');
}

// Scoped to the visible composer: a workspace opened earlier in the test keeps
// its own composer mounted but hidden in the deck, so an unscoped testid
// matches two elements and trips strict mode.
export function attachButton(page: Page) {
  return composerRoot(page).getByTestId("message-input-attach-button");
}

export function terminalPromptInput(page: Page) {
  return composerRoot(page).getByRole("textbox", { name: "Terminal prompt" });
}

/** The static command shown when the selected profile takes no prompt. */
export function terminalCommandPreview(page: Page) {
  return composerRoot(page).getByTestId("composer-readonly-content");
}

export function terminalLaunchSubmit(page: Page) {
  return composerRoot(page).getByTestId("new-workspace-launch-submit");
}

// ─── Actions ───────────────────────────────────────────────────────────────

export async function openLaunchMenu(page: Page): Promise<void> {
  await launchTrigger(page).click();
  await expect(launchMenu(page)).toBeVisible({ timeout: 30_000 });
}

/** `optionId` is `chat`, `blank`, or a terminal profile id. */
export async function selectLaunchOption(page: Page, optionId: string): Promise<void> {
  await openLaunchMenu(page);
  const option = launchOption(page, optionId);
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(launchMenu(page)).toHaveCount(0);
}

export async function selectChatLaunch(page: Page): Promise<void> {
  await selectLaunchOption(page, "chat");
}

export async function fillTerminalPrompt(page: Page, text: string): Promise<void> {
  const input = terminalPromptInput(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(text);
}

export async function submitTerminalLaunch(page: Page): Promise<void> {
  const submit = terminalLaunchSubmit(page);
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
}

// ─── Assertions ────────────────────────────────────────────────────────────

export async function expectChatComposerActive(page: Page): Promise<void> {
  await expect(composerRoot(page)).toBeVisible({ timeout: 30_000 });
  await expect(attachButton(page)).toBeVisible({ timeout: 30_000 });
  await expect(terminalLaunchSubmit(page)).toHaveCount(0);
}

export async function expectTerminalComposerActive(page: Page): Promise<void> {
  await expect(composerRoot(page)).toBeVisible({ timeout: 30_000 });
  await expect(terminalLaunchSubmit(page)).toBeVisible({ timeout: 30_000 });
  await expect(attachButton(page)).toHaveCount(0);
}

export async function expectLaunchTriggerLabel(page: Page, label: string): Promise<void> {
  await expect(launchTrigger(page)).toContainText(label);
}

export async function expectChatLaunchSelected(page: Page): Promise<void> {
  await expectLaunchTriggerLabel(page, "Chat");
  await expectChatComposerActive(page);
}

export async function expectTerminalLaunchSelected(
  page: Page,
  profileLabel: string,
): Promise<void> {
  await expectLaunchTriggerLabel(page, profileLabel);
  await expectTerminalComposerActive(page);
}

export async function expectTerminalPreviewCommand(page: Page, command: string): Promise<void> {
  const preview = terminalCommandPreview(page);
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).toHaveText(command);
}

function terminalContentIncludes(expected: string) {
  return (text: string) => text.includes(expected);
}

/** Waits for the spawned terminal's rendered output to contain `expected`. */
export async function expectTerminalOutputContains(
  page: Page,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForTerminalContent(page, terminalContentIncludes(expected), timeoutMs);
}

/**
 * Waits for the New workspace submit to land on a workspace with a terminal
 * tab open, and returns the terminal id. Scoped to visible elements: earlier
 * workspace decks stay mounted (offscreen) for fast switching, so an
 * unscoped terminal-surface locator can match more than one.
 */
export async function expectWorkspaceOpensWithTerminalTab(page: Page): Promise<string> {
  const terminalTab = page.locator('[data-testid^="workspace-tab-terminal_"]:visible');
  await expect(terminalTab.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="terminal-surface"]:visible').first()).toBeVisible({
    timeout: 30_000,
  });
  const testId = await terminalTab.first().getAttribute("data-testid");
  const terminalId = testId?.replace("workspace-tab-terminal_", "") ?? "";
  if (!terminalId) {
    throw new Error(`Could not parse terminal id from tab testID: ${testId}`);
  }
  return terminalId;
}
