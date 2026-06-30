import type { Logger } from "pino";
import {
  generateWorkspaceTitleFromActivity,
  type GenerateWorkspaceTitleFromActivityOptions,
} from "./workspace-title-generator.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

const AUTO_TITLE_COOLDOWN_MS = 60_000;

interface WorkspaceAutoTitleUpdateSchedulerOptions {
  agentManager: AgentManager;
  workspaceRegistry: WorkspaceRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "resolveRepoRoot">;
  logger: Logger;
  onTitleGenerated?: (workspaceId: string) => void | Promise<void>;
  deps?: {
    generateWorkspaceTitleFromActivity?: (
      options: GenerateWorkspaceTitleFromActivityOptions,
    ) => Promise<string | null>;
  };
}

interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  scheduledAt: number;
}

export class WorkspaceAutoTitleUpdateScheduler {
  private readonly options: WorkspaceAutoTitleUpdateSchedulerOptions;
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly lastRunByWorkspaceId = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly unsubscribeFromAgentManager: () => void;

  constructor(options: WorkspaceAutoTitleUpdateSchedulerOptions) {
    this.options = options;
    this.unsubscribeFromAgentManager = options.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream") {
          this.handleAgentStreamEvent(event.agentId, event.event);
        }
      },
      { replayState: false },
    );
  }

  destroy(): void {
    this.unsubscribeFromAgentManager();
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.lastRunByWorkspaceId.clear();
    this.running.clear();
  }

  handleAgentStreamEvent(agentId: string, event: AgentStreamEvent): void {
    if (
      event.type !== "turn_completed" &&
      event.type !== "turn_failed" &&
      event.type !== "turn_canceled"
    ) {
      return;
    }

    const agent = this.options.agentManager.getAgent(agentId);
    if (!agent || agent.internal || !agent.workspaceId) {
      this.options.logger.debug(
        { agentId, workspaceId: agent?.workspaceId, internal: agent?.internal },
        "auto_title.skip_agent",
      );
      return;
    }

    this.options.logger.debug(
      { agentId, workspaceId: agent.workspaceId, eventType: event.type },
      "auto_title.schedule",
    );
    this.schedule(agent.workspaceId, agent.cwd);
  }

  private schedule(workspaceId: string, cwd: string): void {
    const existing = this.pending.get(workspaceId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const now = Date.now();
    const pendingUpdate: PendingUpdate = {
      scheduledAt: now,
      timer: setTimeout(() => {
        this.pending.delete(workspaceId);
        void this.runUpdate(workspaceId, cwd);
      }, AUTO_TITLE_COOLDOWN_MS),
    };
    this.pending.set(workspaceId, pendingUpdate);
  }

  private async runUpdate(workspaceId: string, cwd: string): Promise<void> {
    if (this.running.has(workspaceId)) {
      return;
    }
    this.running.add(workspaceId);

    try {
      const now = Date.now();
      const lastRun = this.lastRunByWorkspaceId.get(workspaceId) ?? 0;
      if (now - lastRun < AUTO_TITLE_COOLDOWN_MS) {
        return;
      }

      const workspace = await this.options.workspaceRegistry.get(workspaceId);
      if (!workspace || workspace.archivedAt || !workspace.autoUpdateTitle) {
        this.logSkipRun(workspaceId, workspace);
        return;
      }

      const titleBeforeGeneration = workspace.title;
      this.lastRunByWorkspaceId.set(workspaceId, now);

      try {
        const title = await this.generateTitle(workspaceId, cwd);
        if (!title) {
          return;
        }

        const current = await this.options.workspaceRegistry.get(workspaceId);
        if (!current || current.archivedAt || !current.autoUpdateTitle) {
          return;
        }

        if (current.title !== titleBeforeGeneration) {
          this.options.logger.info(
            { workspaceId, from: titleBeforeGeneration, currentTitle: current.title },
            "auto_title.skip_concurrent_manual_rename",
          );
          return;
        }

        if (title === (current.title ?? current.displayName)) {
          return;
        }

        this.options.logger.info(
          { workspaceId, from: current.title ?? current.displayName, to: title },
          "auto_title.apply",
        );
        await this.options.workspaceRegistry.upsert({
          ...current,
          title,
          updatedAt: new Date().toISOString(),
        });

        await this.options.onTitleGenerated?.(workspaceId);
      } catch (error) {
        this.options.logger.warn(
          { err: error, workspaceId, cwd },
          "Failed to auto-update workspace title",
        );
      }
    } finally {
      this.running.delete(workspaceId);
    }
  }

  private logSkipRun(
    workspaceId: string,
    workspace: Awaited<ReturnType<WorkspaceRegistry["get"]>>,
  ): void {
    this.options.logger.debug(
      {
        workspaceId,
        exists: Boolean(workspace),
        archivedAt: workspace?.archivedAt,
        autoUpdateTitle: workspace?.autoUpdateTitle,
      },
      "auto_title.skip_run",
    );
  }

  private async generateTitle(workspaceId: string, cwd: string): Promise<string | null> {
    this.options.logger.debug({ workspaceId, cwd }, "auto_title.generate");
    const title = await (
      this.options.deps?.generateWorkspaceTitleFromActivity ?? generateWorkspaceTitleFromActivity
    )({
      workspaceId,
      cwd,
      agentManager: this.options.agentManager,
      workspaceGitService: this.options.workspaceGitService,
      logger: this.options.logger,
    });

    if (!title) {
      this.options.logger.debug({ workspaceId }, "auto_title.no_title");
    }
    return title;
  }
}
