import { expect, type Page } from "@playwright/test";
import type { TerminalActivity, TerminalActivityState } from "@getpaseo/protocol/terminal-activity";
import { createTempGitRepo } from "./workspace";
import { navigateToTerminal, setupDeterministicPrompt } from "./terminal-perf";
import { connectSeedClient, type SeedDaemonClient } from "./seed-client";

interface TempRepo {
  path: string;
  cleanup: () => Promise<void>;
}

export interface TerminalInstance {
  id: string;
  name: string;
  cwd: string;
}

interface CreateTerminalInput {
  name: string;
  command?: string;
  args?: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TerminalE2EHarness {
  readonly client: SeedDaemonClient;
  readonly tempRepo: TempRepo;
  readonly projectId: string;
  readonly workspaceId: string;
  private readonly otherWorkspaces: TerminalE2EHarness[] = [];

  private constructor(input: {
    client: SeedDaemonClient;
    tempRepo: TempRepo;
    projectId: string;
    workspaceId: string;
  }) {
    this.client = input.client;
    this.tempRepo = input.tempRepo;
    this.projectId = input.projectId;
    this.workspaceId = input.workspaceId;
  }

  static async create(input: { tempPrefix: string }): Promise<TerminalE2EHarness> {
    const tempRepo = await createTempGitRepo(input.tempPrefix);
    const client = await connectSeedClient();
    const seedResult = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!seedResult.workspace) {
      await client.close().catch(() => {});
      await tempRepo.cleanup().catch(() => {});
      throw new Error(seedResult.error ?? "Failed to seed workspace");
    }
    return new TerminalE2EHarness({
      client,
      tempRepo,
      projectId: seedResult.workspace.projectId,
      workspaceId: seedResult.workspace.id,
    });
  }

  async cleanup(): Promise<void> {
    for (const workspace of this.otherWorkspaces) await workspace.cleanup();
    await this.client.removeProject(this.projectId).catch(() => {});
    await this.client.close().catch(() => {});
    await this.tempRepo.cleanup().catch(() => {});
  }

  async createTerminal(input: CreateTerminalInput): Promise<TerminalInstance> {
    const options =
      input.command || input.args
        ? {
            command: input.command,
            args: input.args,
            workspaceId: this.workspaceId,
          }
        : { workspaceId: this.workspaceId };
    const result = await this.client.createTerminal(
      this.tempRepo.path,
      input.name,
      undefined,
      options,
    );
    if (!result.terminal) {
      throw new Error(`Failed to create terminal: ${result.error}`);
    }
    return result.terminal;
  }

  async waitForTerminalActivity(input: {
    terminalId: string;
    state: TerminalActivityState | null;
    attentionReason?: TerminalActivity["attentionReason"] | null;
    timeoutMs?: number;
  }): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.client.listTerminals(this.tempRepo.path, undefined, {
        workspaceId: this.workspaceId,
      });
      const terminal = result.terminals.find((entry) => entry.id === input.terminalId);
      const activity = terminal?.activity ?? null;
      const attentionMatches =
        input.attentionReason === undefined ||
        (activity?.attentionReason ?? null) === input.attentionReason;
      if ((activity?.state ?? null) === input.state && attentionMatches) {
        return;
      }
      await sleep(50);
    }
    const attentionSuffix =
      input.attentionReason === undefined
        ? ""
        : ` with attention ${input.attentionReason ?? "none"}`;
    throw new Error(
      `Timed out waiting for terminal ${input.terminalId} activity state ${input.state ?? "unknown"}${attentionSuffix}`,
    );
  }

  async killTerminal(terminalId: string): Promise<void> {
    await this.client.killTerminal(terminalId).catch(() => {});
  }

  async openTerminal(page: Page, input: { terminalId: string }): Promise<void> {
    await navigateToTerminal(page, {
      workspaceId: this.workspaceId,
      terminalId: input.terminalId,
    });
  }

  async createOtherWorkspace(): Promise<TerminalE2EHarness> {
    const workspace = await TerminalE2EHarness.create({ tempPrefix: "terminal-workspace-focus-" });
    this.otherWorkspaces.push(workspace);
    return workspace;
  }

  async switchToWorkspaceByShortcut(page: Page): Promise<void> {
    const rows = page.locator('[data-testid^="sidebar-workspace-row-"]').filter({ visible: true });
    const rowIds = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    );
    const index = rowIds.findIndex((id) => id?.endsWith(`:${this.workspaceId}`)) + 1;
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThanOrEqual(9);
    // Browser Alt+Digit routes the same workspace action as desktop Cmd+Digit.
    await page.keyboard.press(`Alt+${index}`);
    await expect(page).toHaveURL(new RegExp(`/workspace/${this.workspaceId}`));
  }

  async rememberWorkspaceForHistoryReturn(page: Page): Promise<void> {
    // Workspace shortcuts replace the current route; preserve an in-app history entry.
    await page.evaluate(() =>
      window.history.pushState(window.history.state, "", window.location.href),
    );
  }

  async returnToWorkspaceThroughHistory(page: Page): Promise<void> {
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/workspace/${this.workspaceId}`));
  }

  async moveFocusWithinCommandCenter(page: Page): Promise<void> {
    const panel = page.getByTestId("command-center-panel");
    await expect(panel.getByTestId("command-center-input")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button").first()).toBeFocused();
  }

  async closeOverlayAndFocusButtonBeforeRetry(page: Page): Promise<void> {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-center-panel")).toBeHidden();
    await page.getByTestId("sidebar-search").focus();
    await page.clock.runFor(100);
    await page.clock.resume();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }

  async expectTerminalFocused(page: Page): Promise<void> {
    await expect(
      this.terminalSurface(page).filter({ visible: true }).locator(".xterm-helper-textarea"),
    ).toBeFocused();
  }

  async typeCommandAndExpectOutput(
    page: Page,
    input: { terminalId: string; command: string; output: string },
  ): Promise<void> {
    await page.keyboard.type(input.command);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await this.client.captureTerminal(input.terminalId)).lines)
      .toContain(input.output);
  }

  terminalSurface(page: Page) {
    return page.locator('[data-testid="terminal-surface"]');
  }

  async setupPrompt(page: Page, sentinel?: string): Promise<void> {
    await setupDeterministicPrompt(page, sentinel);
  }
}

export async function withTerminalInApp<T>(
  page: Page,
  harness: TerminalE2EHarness,
  input: { name: string },
  fn: (terminal: TerminalInstance) => Promise<T>,
): Promise<T> {
  const terminal = await harness.createTerminal({ name: input.name });
  try {
    await harness.openTerminal(page, { terminalId: terminal.id });
    return await fn(terminal);
  } finally {
    await harness.killTerminal(terminal.id);
  }
}
