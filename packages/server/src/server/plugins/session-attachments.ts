import { isDeepStrictEqual } from "node:util";
import type pino from "pino";
import type {
  AttachedAgentTool,
  PluginSessionOpenResult,
  PluginSessionRefreshOptions,
  SessionOpenWireRequest,
} from "./agent-tools.js";

/** A running plugin that declares `agent.open.before`. */
export interface SessionOpenPlugin {
  id: string;
  instanceId: string;
  /** Runs this plugin's `agent.open.before` callback and returns its validated result. */
  open(input: SessionOpenWireRequest): Promise<SessionOpenWireRequest>;
  /** Drops the agent's tool definitions inside this plugin's process. */
  detach(agentId: string): void;
}

export interface SessionAttachmentPlugins {
  /** The running plugins that declare `agent.open.before`, in the order a session open runs them. */
  sessionOpenPlugins(): SessionOpenPlugin[];
  /** Every running plugin process, so a closed session leaves no tool definitions behind. */
  detachEverywhere(agentId: string): void;
}

/** What one plugin's `agent.open.before` callback was handed and returned for a session. */
interface Contribution {
  pluginId: string;
  pluginInstanceId: string;
  input: SessionOpenWireRequest;
  output: SessionOpenWireRequest;
  tools: AttachedAgentTool[];
}

interface Attachment {
  base: SessionOpenWireRequest;
  contributions: Contribution[];
  /** A reopen now would launch the provider differently from the running session. */
  stale: boolean;
}

/**
 * Owns what `agent.open.before` plugins attached to each live session: the tools Paseo serves to the agent, and the
 * record of each plugin's contribution that decides whether a plugin change needs the session to reopen.
 *
 * A plugin restart gives it a new instance id. `refresh` reruns the open of only the plugins that changed for the
 * session, swaps in their tools at once, and marks the session stale only when the provider launch would differ.
 * Opens and refreshes of one session run one at a time.
 */
export class SessionAttachments {
  private readonly attachments = new Map<string, Attachment>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly plugins: SessionAttachmentPlugins,
    private readonly logger: pino.Logger,
  ) {}

  async open(request: SessionOpenWireRequest): Promise<PluginSessionOpenResult> {
    return this.serialize(request.agentId, async () => {
      this.close(request.agentId);
      const base: SessionOpenWireRequest = { ...request, tools: [], mcpServers: {} };
      const contributions: Contribution[] = [];
      const mcpServers: SessionOpenWireRequest["mcpServers"] = {};
      const mcpServerOwners: Record<string, string> = {};
      let current = base;
      for (const plugin of this.plugins.sessionOpenPlugins()) {
        const input: SessionOpenWireRequest = { ...current, tools: [], mcpServers: {} };
        try {
          const output = await plugin.open(input);
          collectMcpServers(mcpServers, mcpServerOwners, plugin.id, output.mcpServers);
          const tools = stampTools(plugin, output.tools);
          assertNoToolCollision(contributions, plugin.id, tools);
          contributions.push({
            pluginId: plugin.id,
            pluginInstanceId: plugin.instanceId,
            input,
            output,
            tools,
          });
          current = output;
        } catch (error) {
          this.plugins.detachEverywhere(request.agentId);
          throw new Error(`Plugin ${plugin.id} agent.open.before failed: ${describeError(error)}`, {
            cause: error,
          });
        }
      }
      if (request.purpose === "interactive") {
        this.attachments.set(request.agentId, { base, contributions, stale: false });
      }
      return {
        ...current,
        tools: contributions.flatMap((contribution) => contribution.tools),
        mcpServers,
        mcpServerOwners,
      };
    });
  }

  /**
   * Brings a live session's tools up to date with the running plugins and reports whether the session must reopen
   * to apply the rest. Plugins that did not change since the session opened are not called.
   */
  async refresh(
    agentId: string,
    options: PluginSessionRefreshOptions,
  ): Promise<{ stale: boolean }> {
    const attachment = this.attachments.get(agentId);
    if (!attachment) return { stale: false };
    if (this.isCurrent(attachment)) return { stale: attachment.stale };
    return this.serialize(agentId, () => this.reconcile(agentId, options));
  }

  /** The session's tools from running plugin instances. */
  tools(agentId: string): AttachedAgentTool[] {
    const running = new Map(
      this.plugins.sessionOpenPlugins().map((plugin) => [plugin.id, plugin.instanceId]),
    );
    return (this.attachments.get(agentId)?.contributions ?? [])
      .filter(
        (contribution) => running.get(contribution.pluginId) === contribution.pluginInstanceId,
      )
      .flatMap((contribution) => contribution.tools);
  }

  close(agentId: string): void {
    this.attachments.delete(agentId);
    this.plugins.detachEverywhere(agentId);
  }

  private isCurrent(attachment: Attachment): boolean {
    const running = this.plugins.sessionOpenPlugins();
    return (
      running.length === attachment.contributions.length &&
      running.every((plugin, index) => {
        const contribution = attachment.contributions[index];
        return (
          contribution.pluginId === plugin.id && contribution.pluginInstanceId === plugin.instanceId
        );
      })
    );
  }

  private async reconcile(
    agentId: string,
    options: PluginSessionRefreshOptions,
  ): Promise<{ stale: boolean }> {
    const attachment = this.attachments.get(agentId);
    if (!attachment) return { stale: false };
    if (this.isCurrent(attachment)) return { stale: attachment.stale };
    const running = new Map(this.plugins.sessionOpenPlugins().map((plugin) => [plugin.id, plugin]));
    const recorded = new Map(
      attachment.contributions.map((contribution) => [contribution.pluginId, contribution]),
    );
    const pluginIds = [...new Set([...recorded.keys(), ...running.keys()])].sort((left, right) =>
      left.localeCompare(right),
    );
    let stale = attachment.stale;
    let previous = attachment.base;
    const contributions: Contribution[] = [];
    const replayed: { contribution: Contribution; plugin: SessionOpenPlugin }[] = [];
    for (const pluginId of pluginIds) {
      const plugin = running.get(pluginId);
      const before = recorded.get(pluginId);
      if (plugin && before?.pluginInstanceId === plugin.instanceId) {
        contributions.push(before);
        previous = before.output;
        continue;
      }
      const input: SessionOpenWireRequest = before?.input ?? {
        ...previous,
        tools: [],
        mcpServers: {},
      };
      if (!plugin) {
        // Stopped, or no longer declares the callback: the session loses what it contributed.
        stale ||= !sameLaunch(before!.output, input);
        continue;
      }
      const { contribution, failed } = await this.replay(plugin, input);
      stale ||= failed || !sameLaunch(before?.output ?? input, contribution.output);
      contributions.push(contribution);
      replayed.push({ contribution, plugin });
      previous = contribution.output;
    }
    const collided = await this.dropCollidingTools(agentId, contributions, replayed, options);
    stale ||= collided;
    if (this.attachments.get(agentId) !== attachment) {
      // The session closed during the replay. Its close detached every plugin before the replay attached again.
      for (const { plugin } of replayed) plugin.detach(agentId);
      return { stale: false };
    }
    attachment.contributions = contributions;
    attachment.stale = stale;
    return { stale };
  }

  /** Reruns one plugin's open for a live session, as the reopen the same change would cause. */
  private async replay(
    plugin: SessionOpenPlugin,
    input: SessionOpenWireRequest,
  ): Promise<{ contribution: Contribution; failed: boolean }> {
    const contribution = (output: SessionOpenWireRequest): Contribution => ({
      pluginId: plugin.id,
      pluginInstanceId: plugin.instanceId,
      input,
      output,
      tools: stampTools(plugin, output.tools),
    });
    try {
      return {
        contribution: contribution(await plugin.open({ ...input, reason: "refresh" })),
        failed: false,
      };
    } catch (error) {
      // Recorded under the new instance with no tools, so later requests do not wait on it again. The reopen
      // reruns the callback and reports its error.
      this.logger.warn(
        { err: error, pluginId: plugin.id, agentId: input.agentId },
        "Plugin session refresh failed",
      );
      return { contribution: contribution(input), failed: true };
    }
  }

  /** A replayed plugin whose tool takes a name already in use keeps no tools; the reopen reports the collision. */
  private async dropCollidingTools(
    agentId: string,
    contributions: Contribution[],
    replayed: { contribution: Contribution }[],
    options: PluginSessionRefreshOptions,
  ): Promise<boolean> {
    if (replayed.every(({ contribution }) => contribution.tools.length === 0)) return false;
    const changed = new Set(replayed.map(({ contribution }) => contribution));
    const taken = new Set(await options.reservedToolNames());
    for (const contribution of contributions) {
      if (!changed.has(contribution)) for (const tool of contribution.tools) taken.add(tool.name);
    }
    let collided = false;
    for (const contribution of changed) {
      const conflict = contribution.tools.find((tool) => taken.has(tool.name));
      if (conflict) {
        this.logger.warn(
          { agentId, pluginId: contribution.pluginId, tool: conflict.name },
          "Refreshed plugin tool collides with another agent tool",
        );
        contribution.tools = [];
        collided = true;
        continue;
      }
      for (const tool of contribution.tools) taken.add(tool.name);
    }
    return collided;
  }

  private serialize<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(agentId, settled);
    void settled.finally(() => {
      if (this.tails.get(agentId) === settled) this.tails.delete(agentId);
    });
    return next;
  }
}

/** The parts of a plugin's open result that reach the provider launch. */
function sameLaunch(left: SessionOpenWireRequest, right: SessionOpenWireRequest): boolean {
  return isDeepStrictEqual(launchView(left), launchView(right));
}

function launchView(request: SessionOpenWireRequest) {
  return {
    env: request.env,
    appendSystemPrompt: request.appendSystemPrompt ?? [],
    mcpServers: request.mcpServers,
    tools: request.tools.map(({ name, title, description, inputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
    })),
  };
}

function stampTools(
  plugin: SessionOpenPlugin,
  tools: SessionOpenWireRequest["tools"],
): AttachedAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    pluginId: plugin.id,
    pluginInstanceId: plugin.instanceId,
  }));
}

function assertNoToolCollision(
  contributions: readonly Contribution[],
  pluginId: string,
  tools: readonly AttachedAgentTool[],
): void {
  for (const tool of tools) {
    const owner = contributions.find((contribution) =>
      contribution.tools.some((entry) => entry.name === tool.name),
    );
    if (owner) {
      throw new Error(
        `Agent tool ${tool.name} from plugin ${pluginId} collides with plugin ${owner.pluginId}`,
      );
    }
  }
}

function collectMcpServers(
  servers: SessionOpenWireRequest["mcpServers"],
  owners: Record<string, string>,
  pluginId: string,
  contributions: SessionOpenWireRequest["mcpServers"],
): void {
  for (const [name, server] of Object.entries(contributions)) {
    if (Object.hasOwn(servers, name)) {
      throw new Error(
        `MCP server ${name} from plugin ${pluginId} collides with plugin ${owners[name]}`,
      );
    }
    servers[name] = server;
    owners[name] = pluginId;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
