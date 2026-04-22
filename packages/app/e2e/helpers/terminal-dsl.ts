import type { Page } from "@playwright/test";
import { createTempGitRepo } from "./workspace";
import {
  connectTerminalClient,
  navigateToTerminal,
  setupDeterministicPrompt,
  type TerminalPerfDaemonClient,
} from "./terminal-perf";

type TempRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

export type TerminalInstance = {
  id: string;
  name: string;
  cwd: string;
};

export class TerminalE2EHarness {
  readonly client: TerminalPerfDaemonClient;
  readonly tempRepo: TempRepo;
  readonly workspaceId: string;

  private constructor(input: {
    client: TerminalPerfDaemonClient;
    tempRepo: TempRepo;
    workspaceId: string;
  }) {
    this.client = input.client;
    this.tempRepo = input.tempRepo;
    this.workspaceId = input.workspaceId;
  }

  static async create(input: { tempPrefix: string }): Promise<TerminalE2EHarness> {
    const tempRepo = await createTempGitRepo(input.tempPrefix);
    const client = await connectTerminalClient();
    const seedResult = await client.openProject(tempRepo.path);
    if (!seedResult.workspace) {
      await client.close().catch(() => {});
      await tempRepo.cleanup().catch(() => {});
      throw new Error(seedResult.error ?? "Failed to seed workspace");
    }
    return new TerminalE2EHarness({
      client,
      tempRepo,
      workspaceId: seedResult.workspace.id,
    });
  }

  async cleanup(): Promise<void> {
    await this.client.close().catch(() => {});
    await this.tempRepo.cleanup().catch(() => {});
  }

  async createTerminal(input: { name: string }): Promise<TerminalInstance> {
    const result = await this.client.createTerminal(this.tempRepo.path, input.name);
    if (!result.terminal) {
      throw new Error(`Failed to create terminal: ${result.error}`);
    }
    return result.terminal;
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
