import type { Logger } from "pino";

import {
  buildLiveVoiceStartContext,
  type LiveVoiceContextAgent,
  type LiveVoiceContextSnapshot,
  type LiveVoiceContextWorkspace,
  type LiveVoiceStartContext,
} from "./live-voice-context.js";
import type { LiveVoiceContextProvider } from "./live-voice-coordinator.js";

/** Narrow views of the agent manager and workspace registry, for testability. */
export interface LiveVoiceContextAgentSource {
  listAgents(): Array<{
    id: string;
    provider: string;
    cwd: string;
    workspaceId?: string | undefined;
    lifecycle: string;
    config: { title?: string | null | undefined };
  }>;
  /**
   * Whether sessions launch with Paseo's MCP tools, i.e. can act on Paseo. It is
   * a daemon-wide fact, so it holds for the hidden host session too — MCP
   * injection happens for every created session, internal ones included.
   */
  hasPaseoMcpInjection(): boolean;
}

export interface LiveVoiceContextWorkspaceSource {
  list(): Promise<
    Array<{
      workspaceId: string;
      cwd: string;
      displayName: string;
      title: string | null;
      branch: string | null;
      archivedAt: string | null;
    }>
  >;
}

export interface LiveVoiceDaemonContextOptions {
  agents: LiveVoiceContextAgentSource;
  workspaces: LiveVoiceContextWorkspaceSource;
  logger: Logger;
}

/**
 * Builds the Live Voice context from live daemon state. Closed agent sessions and
 * archived workspaces are left out: the model should only offer to act on things
 * that still exist.
 */
export class LiveVoiceDaemonContextProvider implements LiveVoiceContextProvider {
  private readonly agents: LiveVoiceContextAgentSource;
  private readonly workspaces: LiveVoiceContextWorkspaceSource;
  private readonly logger: Logger;

  constructor(options: LiveVoiceDaemonContextOptions) {
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.logger = options.logger.child({ module: "live-voice-context" });
  }

  async build(options?: {
    crossHostRoutingAvailable: boolean;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string | undefined;
  }): Promise<LiveVoiceStartContext | null> {
    // `listAgents` already omits internal sessions, so the call's own hidden host
    // session never shows up in the snapshot it is given.
    const agents: LiveVoiceContextAgent[] = this.agents
      .listAgents()
      .filter((agent) => agent.lifecycle !== "closed")
      .map((agent) => ({
        id: agent.id,
        provider: agent.provider,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: agent.config.title?.trim() || null,
        lifecycle: agent.lifecycle,
      }));

    const workspaces: LiveVoiceContextWorkspace[] = (await this.workspaces.list())
      .filter((workspace) => workspace.archivedAt === null)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        name: workspace.title?.trim() || workspace.displayName,
        cwd: workspace.cwd,
        branch: workspace.branch,
      }));

    const paseoToolsAvailable = this.agents.hasPaseoMcpInjection();
    const snapshot: LiveVoiceContextSnapshot = {
      agents,
      workspaces,
      paseoToolsAvailable,
    };
    const context = buildLiveVoiceStartContext(snapshot, {
      crossHostRoutingAvailable: options?.crossHostRoutingAvailable ?? true,
      ...(options?.ambientAgentReports ? { ambientAgentReports: true } : {}),
      ...(options?.ambientAgentGuidance
        ? { ambientAgentGuidance: options.ambientAgentGuidance }
        : {}),
    });
    this.logger.debug(
      {
        agentCount: agents.length,
        workspaceCount: workspaces.length,
        itemCount: context.initialItems.length,
        paseoToolsAvailable,
        crossHostRoutingAvailable: options?.crossHostRoutingAvailable ?? true,
        ambientAgentReports: options?.ambientAgentReports === true,
      },
      "live_voice.context.built",
    );
    return context;
  }
}
