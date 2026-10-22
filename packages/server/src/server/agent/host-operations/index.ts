import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonClient,
  type FetchWorkspacesEntry,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { OWNER_PERMISSIONS } from "../../authorization/index.js";
import type { ConnectedHosts } from "../../connected-hosts/index.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import { selectAgentListItems } from "../agent-projections.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import { expandUserPath } from "../../path-utils.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../tools/types.js";

export type HostOperation = (
  input: Record<string, unknown>,
  context: PaseoToolExecutionContext,
) => Promise<PaseoToolResult>;
export interface HostOperations {
  createAgent: HostOperation;
  createWorkspace: HostOperation;
  listWorkspaces: HostOperation;
  sendPrompt: HostOperation;
  getStatus: HostOperation;
  getActivity: HostOperation;
  listAgents: HostOperation;
  wait(agentId: string, signal: AbortSignal): Promise<WaitForFinishResult>;
  observe(
    agentId: string,
    handler: (snapshot: AgentSnapshotPayload | null) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>>;
}
export interface ToolHosts {
  directory(): Promise<HostDirectory>;
  use<T>(serverId: string, action: (client: DaemonClient) => Promise<T>): Promise<T>;
}

/** Daemon MCP has the daemon's authority, bounded by the destination's admission of its link. */
export function createToolHosts(hosts: ConnectedHosts): ToolHosts {
  return {
    directory: () => hosts.list(),
    async use(serverId, action) {
      const lifetime = new AbortController();
      const transportFactory: DaemonTransportFactory = () => {
        const opens = new Set<() => void>();
        const closes = new Set<(event?: unknown) => void>();
        const errors = new Set<(event: unknown) => void>();
        const messages = new Set<(data: unknown, binary: boolean) => void>();
        let closed = false;
        let route: Awaited<ReturnType<ConnectedHosts["openRoute"]>> | undefined;
        void hosts
          .openRoute({
            serverId,
            scopeId: randomUUID(),
            sourceId: "mcp",
            originSessionId: "mcp",
            permissions: OWNER_PERMISSIONS,
            signal: lifetime.signal,
            frame: (data) => {
              for (const listener of messages) listener(data, typeof data !== "string");
            },
            ended: (code, message) => {
              for (const listener of errors)
                listener(Object.assign(new Error(message), { code, serverId }));
              for (const listener of closes) listener();
            },
          })
          .then((opened) => {
            route = opened;
            if (closed) opened.close();
            else for (const listener of opens) listener();
            return undefined;
          })
          .catch((error) => {
            for (const listener of errors) listener(error);
            for (const listener of closes) listener(error);
          });
        return {
          send: (data) => {
            if (!route) throw new Error("Host route is not open");
            route.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          },
          close: () => {
            closed = true;
            route?.close();
          },
          onOpen: (listener) => {
            opens.add(listener);
            return () => opens.delete(listener);
          },
          onClose: (listener) => {
            closes.add(listener);
            return () => closes.delete(listener);
          },
          onError: (listener) => {
            errors.add(listener);
            return () => errors.delete(listener);
          },
          onMessage: (listener) => {
            messages.add(listener);
            return () => messages.delete(listener);
          },
        };
      };
      const client = new DaemonClient({
        url: "ws://host-route/ws",
        clientId: randomUUID(),
        transportFactory,
        reconnect: { enabled: false },
      });
      try {
        await client.connect();
        return await action(client);
      } finally {
        lifetime.abort();
        await client.close();
      }
    },
  };
}

const remoteCreate = z
  .object({
    provider: z.string().min(1),
    title: z.string().trim().min(1).max(60),
    initialPrompt: z.string().min(1),
    workspaceId: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    notifyOnFinish: z.boolean().optional(),
    idempotencyKey: z.string().optional(),
    settings: z
      .object({
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        features: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();
const result = (structuredContent: unknown): PaseoToolResult => ({
  content: [],
  structuredContent,
});

export function createHostResolver(input: {
  serverId: string;
  local: HostOperations;
  hosts: () => ToolHosts;
  callerAgentId?: string;
  lockedCwd?: string;
}) {
  return {
    directory: () => input.hosts().directory(),
    async use<T>(
      serverId: string | undefined,
      action: (host: HostOperations) => Promise<T>,
    ): Promise<T> {
      const destination = serverId ?? input.serverId;
      if (destination === input.serverId) return action(input.local);
      if (input.lockedCwd)
        throw new Error("This caller is restricted to its local working directory");
      return input.hosts().use(destination, async (client) =>
        action({
          async createAgent(args) {
            const parsed = remoteCreate.parse(args);
            const { provider, model } = resolveRequiredProviderModel(parsed.provider);
            const workspace = (await client.fetchWorkspaces({})).entries.find(
              (row) => row.id === parsed.workspaceId,
            );
            if (!workspace) throw new Error(`Workspace ${parsed.workspaceId} not found`);
            const labels = {
              ...parsed.labels,
              ...(input.callerAgentId
                ? parentAddressLabels({ agentId: input.callerAgentId, serverId: input.serverId })
                : {}),
            };
            const snapshot = await client.createAgent({
              config: {
                provider,
                model,
                cwd: workspace.workspaceDirectory,
                title: parsed.title,
                modeId: parsed.settings?.modeId,
                thinkingOptionId: parsed.settings?.thinkingOptionId,
                featureValues: parsed.settings?.features,
              },
              workspaceId: parsed.workspaceId,
              labels,
              initialPrompt: parsed.initialPrompt,
              idempotencyKey: parsed.idempotencyKey,
            });
            return result({
              agentId: snapshot.id,
              type: snapshot.provider,
              status: snapshot.status,
              cwd: snapshot.cwd,
              workspaceId: snapshot.workspaceId,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
            });
          },
          async sendPrompt(args) {
            const agentId = args.agentId as string;
            // Human sends retain the established mode RPC on older connected hosts.
            // Agent sends apply their requested mode when the recipient dispatches the batch.
            if (!input.callerAgentId && args.sessionMode !== undefined) {
              await client.setAgentMode(agentId, args.sessionMode as string);
            }
            const receipt = await client.sendMessage(agentId, args.prompt as string, {
              sessionMode: input.callerAgentId
                ? (args.sessionMode as string | undefined)
                : undefined,
              sourceAgentId: input.callerAgentId,
              sourceAgentServerId: input.callerAgentId ? input.serverId : undefined,
              activeTurnBehavior:
                (args.activeTurnBehavior as ActiveTurnBehavior | undefined) ??
                (input.callerAgentId ? "steer" : "interrupt"),
            });
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              success: true,
              ...receipt,
              status: agent.status,
              guidance:
                receipt.deliveryStatus === "queued"
                  ? "Queued for delivery after two quiet seconds. You will get notified when the prompted agent finishes, errors, or needs permission unless notifyOnFinish is false."
                  : "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
            });
          },
          async getStatus(args) {
            const agent = (await client.fetchAgent(args.agentId as string))?.agent;
            if (!agent) throw new Error(`Agent ${args.agentId} not found`);
            return result({ status: agent.status, snapshot: agent });
          },
          async getActivity(args) {
            const agentId = args.agentId as string;
            const limit = args.limit as number | undefined;
            const timeline = await client.fetchAgentTimeline(agentId, {
              direction: "tail",
              limit: limit ?? 0,
            });
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              agentId,
              ...summarizeAgentActivity(
                timeline.entries.map((entry) => entry.item),
                limit,
              ),
              currentModeId: agent.currentModeId,
            });
          },
          async listAgents(args) {
            const { entries } = await client.fetchAgents({
              includeBackground: args.includeBackground === true,
              filter: { includeArchived: args.includeArchived === true },
            });
            return result({
              agents: selectAgentListItems(
                entries.map((entry) => entry.agent),
                {
                  cwd: (args.cwd as string | undefined)?.trim()
                    ? expandUserPath(args.cwd as string)
                    : undefined,
                  statuses: args.statuses as AgentSnapshotPayload["status"][] | undefined,
                  sinceHours: args.sinceHours as number | undefined,
                  limit: args.limit as number | undefined,
                },
              ),
            });
          },
          async listWorkspaces(args) {
            const { entries } = await client.fetchWorkspaces({
              includeBackground: args.includeBackground === true,
            });
            return result({ workspaces: entries.map(workspaceSummary) });
          },
          async createWorkspace(args) {
            const isolation = z.enum(["local", "worktree"]).parse(args.isolation);
            const path = z.string().min(1).parse(args.path);
            const response = await client.createWorkspace({
              source:
                isolation === "local"
                  ? { kind: "directory", path, projectId: args.projectId as string | undefined }
                  : {
                      kind: "worktree",
                      cwd: path,
                      projectId: args.projectId as string | undefined,
                      action:
                        args.mode === "checkout-branch" || args.mode === "checkout-pr"
                          ? "checkout"
                          : "branch-off",
                      baseBranch: args.baseBranch as string | undefined,
                      branchName: args.branchName as string | undefined,
                      refName: args.branch as string | undefined,
                      githubPrNumber: args.prNumber as number | undefined,
                      worktreeSlug: args.worktreeSlug as string | undefined,
                    },
              title: args.title as string | undefined,
              background: args.background as boolean | undefined,
            });
            if (response.error || !response.workspace)
              throw new Error(response.error ?? "Workspace creation failed");
            return result(workspaceSummary(response.workspace));
          },
          async observe(agentId, handler, signal) {
            const observation = client.observeTimeline([agentId], { signal });
            const refresh = async () => handler((await client.fetchAgent(agentId))?.agent ?? null);
            const unsubscribe = observation.subscribe({
              snapshot: () => {},
              update: (message) => {
                if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;
                const event = message.payload.event;
                if (
                  event.type === "permission_resolved" ||
                  event.type === "turn_started" ||
                  event.type === "turn_completed" ||
                  event.type === "turn_canceled" ||
                  event.type === "turn_failed"
                )
                  void refresh().catch(() => handler(null));
              },
              error: () => handler(null),
            });
            try {
              await observation.ready;
              await refresh();
            } catch (error) {
              unsubscribe();
              await observation.release();
              throw error;
            }
            return async () => {
              unsubscribe();
              await observation.release();
            };
          },
          wait: (agentId, signal) => {
            const close = () => void client.close();
            signal.addEventListener("abort", close, { once: true });
            return client
              .waitForFinish(agentId, 0)
              .finally(() => signal.removeEventListener("abort", close));
          },
        }),
      );
    },
  };
}
function workspaceSummary(workspace: FetchWorkspacesEntry) {
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    kind: workspace.workspaceKind === "checkout" ? "local_checkout" : workspace.workspaceKind,
    title: workspace.title,
    background: workspace.background,
  };
}

/** Wait pauses at permissions; observe only until that request clears before re-arming it. */
export async function waitForPermissionChange(
  host: HostOperations,
  agentId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let changed!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    changed = resolve;
    failed = reject;
  });
  const abort = () => failed(signal.reason ?? new Error("Finish wait stopped"));
  signal.addEventListener("abort", abort, { once: true });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await host.observe(
      agentId,
      (snapshot) => {
        if (!snapshot) failed(new Error(`Agent ${agentId} is unavailable`));
        else if (!snapshot.pendingPermissions.some((request) => request.id === requestId))
          changed();
      },
      signal,
    );
    await ready;
  } finally {
    signal.removeEventListener("abort", abort);
    await release?.();
  }
}
