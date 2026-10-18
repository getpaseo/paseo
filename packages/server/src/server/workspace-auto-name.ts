import type pino from "pino";
import type { AgentAttachment, FirstAgentContext } from "@getpaseo/protocol/messages";

import { toStoredAgentRecord } from "./agent/agent-projections.js";
import { isSystemInjectedEnvelope } from "./agent/agent-prompt.js";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import type { GitMutationService } from "./session/git-mutation/git-mutation-service.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedWorkspaceName,
  type GenerateBranchNameFromFirstAgentContextOptions,
} from "./worktree-branch-name-generator.js";

type WorkspaceNameGenerator = typeof generateBranchNameFromFirstAgentContext;

type CurrentSelection = GenerateBranchNameFromFirstAgentContextOptions["currentSelection"] | null;

interface WorkspaceAutoNameOptions {
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  workspaceGitService: WorkspaceGitService;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
  generateWorkspaceName?: WorkspaceNameGenerator;
}

interface ScheduleContext {
  currentSelection?: CurrentSelection;
  fromFirstAgent?: boolean;
}

interface AutoNameSource {
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list">;
  listAgents: () => Promise<StoredAgentRecord[]>;
  readFirstContext: (agent: StoredAgentRecord) => Promise<FirstAgentContext | null>;
}

export class WorkspaceAutoName {
  private source?: AutoNameSource;
  private stopped = false;
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly processed = new Set<string>();
  private readonly firstPrompts = new Map<string, FirstAgentContext>();
  private readonly creationContexts = new Map<string, FirstAgentContext>();

  captureFirstPrompt(agentId: string, prompt: AgentPromptInput): void {
    const agent = this.agentManager.getAgent(agentId);
    if (
      !agent?.workspaceId ||
      agent.internal ||
      isDelegatedAgent(agent) ||
      this.firstPrompts.has(agentId)
    )
      return;
    let context: FirstAgentContext;
    if (typeof prompt === "string") context = { prompt };
    else
      context = {
        prompt: prompt
          .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
          .join("\n"),
        attachments: prompt.filter(
          (block): block is AgentAttachment => "mimeType" in block && block.type !== "image",
        ),
      };
    this.firstPrompts.set(agentId, context);
    void this.scheduleFromFirstAgent(agent.workspaceId).catch((err) =>
      this.logger.warn(
        { err, workspaceId: agent.workspaceId },
        "Failed to capture workspace naming context",
      ),
    );
  }

  start(source: AutoNameSource): () => void {
    this.source = source;
    const unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (
          event.type !== "agent_stream" ||
          event.event.type !== "timeline" ||
          event.event.item.type !== "user_message"
        )
          return;
        const agent = this.agentManager.getAgent(event.agentId);
        if (!agent?.workspaceId || agent.internal || isDelegatedAgent(agent)) return;
        void this.scheduleFromFirstAgent(agent.workspaceId).catch((err) => {
          this.logger.warn(
            { err, workspaceId: agent.workspaceId },
            "Failed to resolve workspace naming context",
          );
        });
      },
      { replayState: false },
    );
    return () => {
      this.stopped = true;
      unsubscribe();
    };
  }

  async recover(): Promise<void> {
    if (!this.source) return;
    for (const workspace of await this.source.workspaceRegistry.list()) {
      if (this.stopped) return;
      if (workspace.archivedAt) continue;
      if (!this.needsName(workspace)) continue;
      try {
        await this.scheduleFromFirstAgent(workspace.workspaceId);
        await this.scheduled.get(workspace.workspaceId);
      } catch (err) {
        this.logger.warn(
          { err, workspaceId: workspace.workspaceId },
          "Workspace naming recovery failed",
        );
      }
    }
  }

  private needsName(workspace: PersistedWorkspaceRecord): boolean {
    if (!workspace.title) return true;
    if (workspace.kind !== "worktree") return false;
    try {
      const metadata = readPaseoWorktreeMetadata(workspace.worktreeRoot ?? workspace.cwd);
      return (
        metadata?.version === 2 &&
        !!metadata.firstAgentBranchAutoName &&
        metadata.firstAgentBranchAutoName.status !== "succeeded"
      );
    } catch (err) {
      this.logger.info(
        { err, workspaceId: workspace.workspaceId },
        "Skipping worktree without readable naming metadata",
      );
      return false;
    }
  }

  private async scheduleFromFirstAgent(workspaceId: string): Promise<void> {
    const source = this.source;
    if (!source || this.scheduled.has(workspaceId) || this.processed.has(workspaceId)) return;
    const workspace = await source.workspaceRegistry.get(workspaceId);
    if (!workspace || workspace.archivedAt || !this.needsName(workspace)) return;
    const resolved = await this.resolveNamingContext(source, workspace);
    if (!resolved) return;
    const { firstAgentContext, selection } = resolved;
    const input = { firstAgentContext, workspaceId, cwd: workspace.cwd };
    if (workspace.kind === "worktree")
      this.scheduleForWorktree(
        { workspace, firstAgentContext },
        { currentSelection: selection, fromFirstAgent: true },
      );
    else if (!workspace.title)
      this.scheduleForDirectory(input, { currentSelection: selection, fromFirstAgent: true });
  }

  private async firstPrimaryAgent(source: AutoNameSource, workspaceId: string) {
    const records = new Map((await source.listAgents()).map((agent) => [agent.id, agent]));
    for (const agent of this.agentManager.listAgents())
      records.set(agent.id, toStoredAgentRecord(agent));
    const agents = [...records.values()].filter(
      (agent) => agent.workspaceId === workspaceId && !agent.internal && !isDelegatedAgent(agent),
    );
    agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return agents[0];
  }

  private async resolveNamingContext(source: AutoNameSource, workspace: PersistedWorkspaceRecord) {
    const workspaceId = workspace.workspaceId;
    const first = await this.firstPrimaryAgent(source, workspaceId);
    const saved = workspace.autoName;
    if (!first && !saved) {
      this.logger.info({ workspaceId }, "Skipping workspace naming: no primary agent context");
      return null;
    }
    const message = this.firstLiveMessage(first);
    let firstAgentContext = saved?.firstAgentContext ?? this.creationContexts.get(workspaceId);
    if (!firstAgentContext && first) firstAgentContext = this.firstPrompts.get(first.id);
    if (!firstAgentContext && message?.type === "user_message")
      firstAgentContext = { prompt: message.text };
    if (!firstAgentContext && first)
      firstAgentContext = (await source.readFirstContext(first)) ?? undefined;
    if (!firstAgentContext || !buildAgentBranchNameSeed(firstAgentContext)) {
      this.logger.info(
        { workspaceId, agentId: first?.id },
        "Skipping workspace naming: first message unavailable",
      );
      return null;
    }
    const selection = saved?.selection ?? this.selectionForAgent(first);
    return { firstAgentContext, selection };
  }

  private firstLiveMessage(first: StoredAgentRecord | undefined) {
    const live = first ? this.agentManager.getAgent(first.id) : null;
    // A resumed agent can receive a new message before its older history is loaded.
    if (!live?.historyPrimed) return null;
    return this.agentManager
      .getTimeline(live.id)
      .find((item) => item.type === "user_message" && !isSystemInjectedEnvelope(item.text));
  }

  private selectionForAgent(agent: StoredAgentRecord | undefined): CurrentSelection {
    if (!agent) return null;
    return {
      provider: agent.provider,
      model: agent.runtimeInfo?.model ?? agent.config?.model,
      thinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? agent.config?.thinkingOptionId,
    };
  }

  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly readDaemonConfig: () => StructuredGenerationDaemonConfig;
  private readonly gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  private readonly emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly logger: pino.Logger;
  private readonly generateWorkspaceName: WorkspaceNameGenerator;

  constructor(options: WorkspaceAutoNameOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.gitMutation = options.gitMutation;
    this.emitWorkspaceUpdateForCwd = options.emitWorkspaceUpdateForCwd;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.logger = options.logger;
    this.generateWorkspaceName =
      options.generateWorkspaceName ?? generateBranchNameFromFirstAgentContext;
  }

  scheduleForWorktree(
    input: {
      workspace: PersistedWorkspaceRecord;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    if (this.source && !context.fromFirstAgent) {
      if (
        !this.creationContexts.has(input.workspace.workspaceId) &&
        buildAgentBranchNameSeed(input.firstAgentContext)
      )
        this.creationContexts.set(input.workspace.workspaceId, input.firstAgentContext);
      void this.scheduleFromFirstAgent(input.workspace.workspaceId).catch((err) =>
        this.logger.warn(
          { err, workspaceId: input.workspace.workspaceId },
          "Workspace naming deferred",
        ),
      );
      return;
    }
    this.schedule(
      () =>
        this.maybeAutoNameWorkspaceBranchForFirstAgent({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        workspaceId: input.workspace.workspaceId,
        cwd: input.workspace.cwd,
        message: "Failed to auto-name worktree branch",
      },
    );
  }

  scheduleForDirectory(
    input: {
      workspaceId: string;
      cwd: string;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    if (this.source && !context.fromFirstAgent) {
      if (
        !this.creationContexts.has(input.workspaceId) &&
        buildAgentBranchNameSeed(input.firstAgentContext)
      )
        this.creationContexts.set(input.workspaceId, input.firstAgentContext);
      void this.scheduleFromFirstAgent(input.workspaceId).catch((err) =>
        this.logger.warn({ err, workspaceId: input.workspaceId }, "Workspace naming deferred"),
      );
      return;
    }
    this.schedule(
      () =>
        this.maybeAutoNameDirectoryWorkspaceTitle({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        message: "Failed to auto-name directory workspace title",
      },
    );
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    await this.preserveContext(
      input.workspace.workspaceId,
      input.firstAgentContext,
      input.currentSelection,
    );
    const worktreeRoot = input.workspace.worktreeRoot ?? input.workspace.cwd;
    let generated: GeneratedWorkspaceName | null = null;
    let generationAttempted = false;
    const result: AttemptFirstAgentBranchAutoNameResult = await attemptFirstAgentBranchAutoName({
      cwd: worktreeRoot,
      logger: this.logger.child({ workspaceId: input.workspace.workspaceId }),
      firstAgentContext: input.firstAgentContext,
      generateBranchNameFromContext: ({ firstAgentContext }) => {
        generationAttempted = true;
        return this.generateFromContext({
          cwd: input.workspace.cwd,
          firstAgentContext,
          currentSelection: input.currentSelection,
        }).then((nextGenerated) => {
          if (this.stopped) return null;
          generated = nextGenerated;
          return nextGenerated?.branch ?? null;
        });
      },
    });

    if (!generationAttempted) {
      generated = await this.generateFromContext({
        cwd: input.workspace.cwd,
        firstAgentContext: input.firstAgentContext,
        currentSelection: input.currentSelection,
      });
    }
    if (this.stopped) return;
    const generatedTitle = generated?.title ?? null;
    if (!generatedTitle) throw new Error("Workspace name generation returned no result");

    // K4: re-read from the registry before writing so any concurrent upsert
    // that happened between workspace creation and this async path is not clobbered.
    // When the first-agent rename changed the git branch too, persist that branch
    // alongside the title — both are this path's own fields.
    await this.applyGeneratedWorkspaceTitle(input.workspace.workspaceId, {
      title: generatedTitle,
      ...(result.renamed ? { branch: result.branchName } : {}),
    });
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
    if (result.renamed) {
      await this.gitMutation.notifyGitMutation(worktreeRoot, "rename-branch");
    }
  }

  private async maybeAutoNameDirectoryWorkspaceTitle(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    await this.preserveContext(input.workspaceId, input.firstAgentContext, input.currentSelection);
    const generated = await this.generateFromContext({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
      currentSelection: input.currentSelection,
    });
    if (this.stopped) return;
    const title = generated?.title ?? null;
    if (!title) throw new Error("Workspace name generation returned no result");
    // K4: applyGeneratedWorkspaceTitle re-reads from the registry before writing.
    // Directory workspaces have no branch — write only the title.
    await this.applyGeneratedWorkspaceTitle(input.workspaceId, {
      title,
    });
    await this.emitWorkspaceUpdateForWorkspaceId(input.workspaceId);
  }

  private async applyGeneratedWorkspaceTitle(
    workspaceId: string,
    input: { title: string; branch?: string | null },
  ): Promise<void> {
    await this.workspaceRegistry.update(workspaceId, (current) => {
      let title = current.title;
      if (!title) {
        title = input.title;
      }
      return {
        ...current,
        title,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private generateFromContext(input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<GeneratedWorkspaceName | null> {
    return this.generateWorkspaceName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      workspaceGitService: this.workspaceGitService,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentSelection: input.currentSelection ?? undefined,
      firstAgentContext: input.firstAgentContext,
      logger: this.logger,
    });
  }

  private async preserveContext(
    workspaceId: string,
    firstAgentContext: FirstAgentContext,
    selection: CurrentSelection,
  ): Promise<void> {
    await this.workspaceRegistry.update(workspaceId, (current) =>
      current.autoName
        ? current
        : {
            ...current,
            autoName: {
              firstAgentContext,
              ...(selection?.provider
                ? { selection: { ...selection, provider: selection.provider } }
                : {}),
            },
          },
    );
  }

  private schedule(
    run: () => Promise<void>,
    context: { workspaceId: string; cwd: string; message: string },
  ): void {
    if (
      this.stopped ||
      this.scheduled.has(context.workspaceId) ||
      this.processed.has(context.workspaceId)
    )
      return;
    const pending = new Promise<void>((resolve) =>
      setTimeout(() => {
        void (async () => {
          try {
            for (let attempt = 1; attempt <= 3; attempt++) {
              if (this.stopped) return;
              try {
                await run();
                return;
              } catch (err) {
                this.logger.warn({ err, ...context, attempt }, context.message);
              }
            }
          } finally {
            this.scheduled.delete(context.workspaceId);
            this.processed.add(context.workspaceId);
            this.creationContexts.delete(context.workspaceId);
            resolve();
          }
        })();
      }, 0),
    );
    this.scheduled.set(context.workspaceId, pending);
  }
}
