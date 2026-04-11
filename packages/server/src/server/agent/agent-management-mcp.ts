/**
 * Agent Management MCP Server
 *
 * Purpose: Managing agents from the UI/voice assistant LLM
 * Transport: In-memory (runs in-process with the voice assistant LLM)
 * Server name: "paseo-agent-management"
 *
 * Tools:
 * - create_agent
 * - wait_for_agent
 * - send_agent_prompt
 * - get_agent_status
 * - list_agents
 * - cancel_agent
 * - kill_agent
 * - get_agent_activity
 * - set_agent_mode
 * - list_pending_permissions
 * - respond_to_permission
 *
 * No callerAgentId needed - voice assistant is not an agent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureValidJson } from "../json-utils.js";
import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, WaitForAgentResult } from "./agent-manager.js";
import {
  AgentPermissionRequestPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
} from "../messages.js";
import { toAgentPayload } from "./agent-projections.js";
import { curateAgentActivity } from "./activity-curator.js";
import { AgentStorage } from "./agent-storage.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./timeline-append.js";
import { type WorktreeConfig } from "../../utils/worktree.js";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";
import { scheduleAgentMetadataGeneration } from "./agent-metadata-generator.js";
import { expandUserPath } from "../path-utils.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { createAgentWorktree, runAsyncWorktreeBootstrap } from "../worktree-bootstrap.js";
import type { ScheduleService } from "../schedule/service.js";
import { ScheduleSummarySchema, StoredScheduleSchema } from "../schedule/types.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type ProviderDefinition,
} from "./provider-registry.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderSummarySchema,
  parseDurationString,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  startAgentRun,
  toScheduleSummary,
  waitForAgentWithTimeout,
} from "./mcp-shared.js";

export interface AgentManagementMcpOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  scheduleService?: ScheduleService | null;
  providerRegistry?: Record<AgentProvider, ProviderDefinition> | null;
  paseoHome?: string;
  logger: Logger;
}

export async function createAgentManagementMcpServer(
  options: AgentManagementMcpOptions,
): Promise<McpServer> {
  const { agentManager, agentStorage, scheduleService, providerRegistry, logger } = options;
  const childLogger = logger.child({
    module: "agent",
    component: "agent-management-mcp",
  });
  const waitTracker = new WaitForAgentTracker(logger);
  const resolveNewAgentScheduleTarget = (params?: {
    provider?: AgentProvider;
    cwd?: string;
  }) => ({
    type: "new-agent" as const,
    config: {
      provider: params?.provider ?? ("claude" as AgentProvider),
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
    },
  });

  const server = new McpServer({
    name: "paseo-agent-management",
    version: "1.0.0",
  });

  const inputSchema = {
    cwd: z
      .string()
      .describe("Required working directory for the agent (absolute, relative, or ~)."),
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    agentType: AgentProviderEnum.optional().describe(
      "Optional agent implementation to spawn. Defaults to 'claude'.",
    ),
    model: z
      .string()
      .optional()
      .describe("Model to use (e.g. claude-sonnet-4-20250514)"),
    thinking: z.string().optional().describe("Thinking option ID"),
    labels: z
      .record(z.string(), z.string())
      .optional()
      .describe("Labels to set on the agent"),
    initialPrompt: z
      .string()
      .optional()
      .describe("Optional task to start immediately after creation (non-blocking)."),
    initialMode: z.string().describe("Required session mode to configure before the first run."),
    worktreeName: z
      .string()
      .optional()
      .describe("Optional git worktree branch name (lowercase alphanumerics + hyphen)."),
    baseBranch: z
      .string()
      .optional()
      .describe("Required when worktreeName is set: the base branch to diff/merge against."),
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
  };

  server.registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create a new Claude or Codex agent tied to a working directory. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string().nullable().optional(),
          }),
        ),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async (args) => {
      const {
        cwd,
        agentType,
        initialPrompt,
        initialMode,
        worktreeName,
        baseBranch,
        background = false,
        title,
        model,
        thinking,
        labels,
      } = args as {
        cwd: string;
        agentType?: AgentProvider;
        initialPrompt?: string;
        initialMode: string;
        worktreeName?: string;
        baseBranch?: string;
        background?: boolean;
        title: string;
        model?: string;
        thinking?: string;
        labels?: Record<string, string>;
      };

      let resolvedCwd = expandUserPath(cwd);
      let worktreeConfig: WorktreeConfig | undefined;

      if (worktreeName) {
        if (!baseBranch) {
          throw new Error("baseBranch is required when creating a worktree");
        }
        const worktree = await createAgentWorktree({
          branchName: worktreeName,
          cwd: resolvedCwd,
          baseBranch,
          worktreeSlug: worktreeName,
          paseoHome: options.paseoHome,
        });
        resolvedCwd = worktree.worktreePath;
        worktreeConfig = worktree;
      }

      const provider: AgentProvider = agentType ?? "claude";
      const normalizedTitle = title?.trim() ?? null;
      const snapshot = await agentManager.createAgent(
        {
          provider,
          cwd: resolvedCwd,
          modeId: initialMode,
          title: normalizedTitle ?? undefined,
          model,
          thinkingOptionId: thinking,
        },
        undefined,
        labels ? { labels } : undefined,
      );

      if (worktreeConfig) {
        void runAsyncWorktreeBootstrap({
          agentId: snapshot.id,
          worktree: worktreeConfig,
          terminalManager: options.terminalManager ?? null,
          appendTimelineItem: (item) =>
            appendTimelineItemIfAgentKnown({
              agentManager,
              agentId: snapshot.id,
              item,
            }),
          emitLiveTimelineItem: (item) =>
            emitLiveTimelineItemIfAgentKnown({
              agentManager,
              agentId: snapshot.id,
              item,
            }),
          logger: childLogger,
        });
      }

      const trimmedPrompt = initialPrompt?.trim();
      if (trimmedPrompt) {
        scheduleAgentMetadataGeneration({
          agentManager,
          agentId: snapshot.id,
          cwd: snapshot.cwd,
          initialPrompt: trimmedPrompt,
          explicitTitle: normalizedTitle ?? undefined,
          paseoHome: options.paseoHome,
          logger: childLogger,
        });

        try {
          agentManager.recordUserMessage(snapshot.id, trimmedPrompt, {
            emitState: false,
          });
        } catch (error) {
          childLogger.error(
            { err: error, agentId: snapshot.id },
            "Failed to record initial prompt",
          );
        }

        try {
          startAgentRun(agentManager, snapshot.id, trimmedPrompt, childLogger);

          if (!background) {
            const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
              waitForActive: true,
            });

            const responseData = {
              agentId: snapshot.id,
              type: provider,
              status: result.status,
              cwd: snapshot.cwd,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
              lastMessage: result.lastMessage,
              permission: sanitizePermissionRequest(result.permission),
            };
            const validJson = ensureValidJson(responseData);

            return {
              content: [],
              structuredContent: validJson,
            };
          }
        } catch (error) {
          childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
        }
      }

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId: snapshot.id,
          type: provider,
          status: snapshot.lifecycle,
          cwd: snapshot.cwd,
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
          lastMessage: null,
          permission: null,
        }),
      };
    },
  );

  server.registerTool(
    "wait_for_agent",
    {
      title: "Wait for agent",
      description:
        "Block until the agent requests permission or the current run completes. Returns the pending permission (if any) and recent activity summary.",
      inputSchema: {
        agentId: z.string().describe("Agent identifier returned by the create_agent tool"),
      },
      outputSchema: {
        agentId: z.string(),
        status: AgentStatusEnum,
        permission: AgentPermissionRequestPayloadSchema.nullable(),
        lastMessage: z.string().nullable(),
      },
    },
    async ({ agentId }, { signal }) => {
      const abortController = new AbortController();
      const cleanupFns: Array<() => void> = [];

      const cleanup = () => {
        while (cleanupFns.length) {
          const fn = cleanupFns.pop();
          try {
            fn?.();
          } catch {
            // ignore cleanup errors
          }
        }
      };

      const forwardExternalAbort = () => {
        if (!abortController.signal.aborted) {
          const reason = signal?.reason ?? new Error("wait_for_agent aborted");
          abortController.abort(reason);
        }
      };

      if (signal) {
        if (signal.aborted) {
          forwardExternalAbort();
        } else {
          signal.addEventListener("abort", forwardExternalAbort, {
            once: true,
          });
          cleanupFns.push(() => signal.removeEventListener("abort", forwardExternalAbort));
        }
      }

      const unregister = waitTracker.register(agentId, (reason) => {
        if (!abortController.signal.aborted) {
          abortController.abort(new Error(reason ?? "wait_for_agent cancelled"));
        }
      });
      cleanupFns.push(unregister);

      try {
        const result: WaitForAgentResult = await waitForAgentWithTimeout(agentManager, agentId, {
          signal: abortController.signal,
        });

        const validJson = ensureValidJson({
          agentId,
          status: result.status,
          permission: sanitizePermissionRequest(result.permission),
          lastMessage: result.lastMessage,
        });

        return {
          content: [],
          structuredContent: validJson,
        };
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Returns immediately after the agent begins processing.",
      inputSchema: {
        agentId: z.string(),
        prompt: z.string(),
        sessionMode: z
          .string()
          .optional()
          .describe("Optional mode to set before running the prompt."),
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
          ),
      },
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async ({ agentId, prompt, sessionMode, background = false }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent ${agentId} not found`);
      }

      if (agentManager.hasInFlightRun(agentId)) {
        waitTracker.cancel(agentId, "Agent run interrupted by new prompt");
      }

      if (sessionMode) {
        await agentManager.setAgentMode(agentId, sessionMode);
      }

      try {
        agentManager.recordUserMessage(agentId, prompt, {
          emitState: false,
        });
      } catch (error) {
        childLogger.error({ err: error, agentId }, "Failed to record user message");
      }

      startAgentRun(agentManager, agentId, prompt, childLogger, {
        replaceRunning: true,
      });

      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        return {
          content: [],
          structuredContent: validJson,
        };
      }

      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
      };
      const validJson = ensureValidJson(responseData);

      return {
        content: [],
        structuredContent: validJson,
      };
    },
  );

  server.registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = await serializeSnapshotWithMetadata(
        agentStorage,
        snapshot,
        childLogger,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: snapshot.lifecycle,
          snapshot: structuredSnapshot,
        }),
      };
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List all live agents managed by the server.",
      inputSchema: {},
      outputSchema: {
        agents: z.array(AgentSnapshotPayloadSchema),
      },
    },
    async () => {
      const snapshots = agentManager.listAgents();
      const agents = await Promise.all(
        snapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger),
        ),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const success = await agentManager.cancelAgentRun(agentId);
      if (success) {
        waitTracker.cancel(agentId, "Agent run cancelled");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ success }),
      };
    },
  );

  server.registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await agentManager.archiveAgent(agentId);
      waitTracker.cancel(agentId, "Agent archived");
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await agentManager.closeAgent(agentId);
      waitTracker.cancel(agentId, "Agent terminated");
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name and/or labels.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z
          .record(z.string(), z.string())
          .optional()
          .describe("Labels to set on the agent"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels }) => {
      const trimmedName = name?.trim();
      if (trimmedName) {
        const record = await agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent ${agentId} not found`);
        }
        await agentStorage.upsert({
          ...record,
          title: trimmedName,
          updatedAt: new Date().toISOString(),
        });
        agentManager.notifyAgentState(agentId);
      }

      if (labels) {
        await agentManager.setLabels(agentId, labels);
      }

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that runs on an agent or a new agent.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        every: z.string().optional(),
        cron: z.string().optional(),
        name: z.string().optional(),
        target: z.enum(["self", "new-agent"]).optional(),
        provider: AgentProviderEnum.optional(),
        cwd: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, every, cron, name, target, provider, cwd, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const cadenceCount = Number(every !== undefined) + Number(cron !== undefined);
      if (cadenceCount !== 1) {
        throw new Error("Specify exactly one of every or cron");
      }
      if (target === "self") {
        throw new Error("target=self requires a caller agent");
      }

      const schedule = await scheduleService.create({
        prompt: prompt.trim(),
        cadence: every
          ? { type: "every" as const, everyMs: parseDurationString(every) }
          : { type: "cron" as const, expression: cron!.trim() },
        target: resolveNewAgentScheduleTarget({ provider, cwd }),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresIn === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + parseDurationString(expiresIn)).toISOString() }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  server.registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list()).map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  server.registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await scheduleService.inspect(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  server.registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List available agent providers and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => ({
      content: [],
      structuredContent: ensureValidJson({
        providers: AGENT_PROVIDER_DEFINITIONS.map((provider) => ({
          id: provider.id,
          label: provider.label,
          modes: provider.modes.map((mode) => ({
            id: mode.id,
            label: mode.label,
            ...(mode.description ? { description: mode.description } : {}),
          })),
        })),
      }),
    }),
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      if (!providerRegistry) {
        throw new Error("Provider registry is not configured");
      }

      const definition = providerRegistry[provider];
      if (!definition) {
        throw new Error(`Provider ${provider} is not configured`);
      }

      const models = await definition.fetchModels();
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  server.registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      const activitiesToCurate = limit ? timeline.slice(-limit) : timeline;

      const curatedContent = curateAgentActivity(activitiesToCurate);
      const totalCount = timeline.length;
      const shownCount = activitiesToCurate.length;

      let countHeader: string;
      if (limit && shownCount < totalCount) {
        countHeader = `Showing ${shownCount} of ${totalCount} ${totalCount === 1 ? "activity" : "activities"} (limited to ${limit})`;
      } else {
        countHeader = `Showing all ${totalCount} ${totalCount === 1 ? "activity" : "activities"}`;
      }

      const contentWithCount = `${countHeader}\n\n${curatedContent}`;

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: contentWithCount,
        }),
      };
    },
  );

  server.registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      await agentManager.setAgentMode(agentId, modeId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: modeId }),
      };
    },
  );

  server.registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request,
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  server.registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await agentManager.respondToPermission(agentId, requestId, response);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  return server;
}
