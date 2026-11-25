import { isDeepStrictEqual } from "node:util";
import type pino from "pino";
import type {
  AttachedAgentTool,
  PluginSessionOpenResult,
  PluginSessionRefreshOptions,
  SessionOpenAgentFacts,
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
  /** The plugin process holds this contribution's tool definitions for the session. */
  synced: boolean;
  /** Its rerun failed or its tools collided, so its tools stay off until the reopen reports why. */
  failed: boolean;
}

interface Attachment {
  base: SessionOpenWireRequest;
  /** What each plugin contributed to the provider launch the session is running. */
  launched: readonly Contribution[];
  /** What each plugin contributes now, after the refreshes since that launch. */
  contributions: Contribution[];
  /** A reopen now would launch the provider differently from the running session. */
  stale: boolean;
}

/**
 * Owns what `agent.open.before` plugins attached to each live session: the tools Paseo serves to the agent, and the
 * record of each plugin's contribution that decides whether a plugin change needs the session to reopen.
 *
 * A plugin restart gives it a new instance id. `refresh` reruns the open of only the plugins that changed for the
 * session, swaps in their tools at once, and marks the session stale only when the provider launch would differ from
 * the one it runs. An open becomes the baseline only once its provider launch takes over the session, so a failed open
 * or launch leaves the running launch as the baseline. Opens and refreshes of one session run one at a time.
 */
export class SessionAttachments {
  private readonly attachments = new Map<string, Attachment>();
  /** Interactive opens whose provider launch has not taken over the session yet. */
  private readonly pending = new Map<string, Attachment>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly plugins: SessionAttachmentPlugins,
    private readonly logger: pino.Logger,
  ) {}

  async open(request: SessionOpenWireRequest): Promise<PluginSessionOpenResult> {
    return this.serialize(request.agentId, async () => {
      // Each plugin attaches its tools again below, and a plugin that left the chain keeps none. Until the launch
      // takes over, the running session's record stays, and its plugins attach again on its next refresh if the
      // launch fails.
      this.plugins.detachEverywhere(request.agentId);
      for (const contribution of this.attachments.get(request.agentId)?.contributions ?? []) {
        contribution.synced = false;
      }
      const base: SessionOpenWireRequest = { ...request, tools: [], mcpServers: {} };
      const contributions: Contribution[] = [];
      let current = base;
      for (const plugin of this.plugins.sessionOpenPlugins()) {
        const input: SessionOpenWireRequest = { ...current, tools: [], mcpServers: {} };
        try {
          const output = await plugin.open(input);
          const tools = stampTools(plugin, output.tools);
          assertNoToolCollision(contributions, plugin.id, tools);
          contributions.push({
            pluginId: plugin.id,
            pluginInstanceId: plugin.instanceId,
            input,
            output,
            tools,
            synced: true,
            failed: false,
          });
          current = output;
        } catch (error) {
          this.plugins.detachEverywhere(request.agentId);
          throw new Error(`Plugin ${plugin.id} agent.open.before failed: ${describeError(error)}`, {
            cause: error,
          });
        }
      }
      let launch: PluginSessionOpenResult;
      try {
        launch = composeLaunch(base, contributions);
      } catch (error) {
        this.plugins.detachEverywhere(request.agentId);
        throw error;
      }
      if (request.purpose === "interactive") {
        this.pending.set(request.agentId, {
          base,
          launched: contributions,
          contributions: [...contributions],
          stale: false,
        });
      }
      return launch;
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
    // A launch in progress attaches its own tools and takes over once it succeeds.
    if (!attachment || this.pending.has(agentId)) return { stale: false };
    if (this.isCurrent(attachment)) return { stale: attachment.stale };
    return this.serialize(agentId, () => this.reconcile(agentId, options));
  }

  /** The provider session launched with the last open's result and now runs it. */
  launched(agentId: string): void {
    const opened = this.pending.get(agentId);
    if (!opened) return;
    this.pending.delete(agentId);
    this.attachments.set(agentId, opened);
  }

  /** The last open's result never launched. The session that is still running keeps its record. */
  launchFailed(agentId: string): void {
    // Nothing is pending once a launch took over; its later failures close the session instead.
    if (!this.pending.delete(agentId)) return;
    this.plugins.detachEverywhere(agentId);
  }

  /** The session's tools from running plugin instances. */
  tools(agentId: string): AttachedAgentTool[] {
    const running = new Map(
      this.plugins.sessionOpenPlugins().map((plugin) => [plugin.id, plugin.instanceId]),
    );
    const attachment = this.pending.get(agentId) ?? this.attachments.get(agentId);
    return (attachment?.contributions ?? [])
      .filter(
        (contribution) =>
          contribution.synced &&
          running.get(contribution.pluginId) === contribution.pluginInstanceId,
      )
      .flatMap((contribution) => contribution.tools);
  }

  close(agentId: string): void {
    this.pending.delete(agentId);
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
          contribution.synced &&
          contribution.pluginId === plugin.id &&
          contribution.pluginInstanceId === plugin.instanceId
        );
      })
    );
  }

  private async reconcile(
    agentId: string,
    options: PluginSessionRefreshOptions,
  ): Promise<{ stale: boolean }> {
    const attachment = this.attachments.get(agentId);
    if (!attachment || this.pending.has(agentId)) return { stale: false };
    if (this.isCurrent(attachment)) return { stale: attachment.stale };
    const recorded = new Map(
      attachment.contributions.map((contribution) => [contribution.pluginId, contribution]),
    );
    // The running plugins in open order, as a reopen would run them. A stopped plugin, or one that no longer declares
    // the callback, drops out, and the plugins after it see the chain without it.
    let previous = attachment.base;
    const contributions: Contribution[] = [];
    const replayed: { contribution: Contribution; plugin: SessionOpenPlugin }[] = [];
    let facts: SessionOpenAgentFacts | undefined;
    for (const plugin of this.plugins.sessionOpenPlugins()) {
      const before = recorded.get(plugin.id);
      if (before && isReusable(before, plugin, previous)) {
        contributions.push(before);
        previous = before.output;
        continue;
      }
      facts ??= await options.agentFacts();
      const contribution = await this.replay(plugin, {
        ...previous,
        ...facts,
        tools: [],
        mcpServers: {},
      });
      contributions.push(contribution);
      replayed.push({ contribution, plugin });
      previous = contribution.output;
    }
    await this.dropCollidingTools({
      agentId,
      owners: toolOwners(attachment.contributions),
      contributions,
      replayed,
      options,
    });
    if (this.attachments.get(agentId) !== attachment) {
      // The session closed during the replay. Its close detached every plugin before the replay attached again.
      for (const { plugin } of replayed) plugin.detach(agentId);
      return { stale: false };
    }
    attachment.contributions = contributions;
    attachment.stale =
      contributions.some((contribution) => contribution.failed) ||
      !launchesMatch(attachment.base, attachment.launched, contributions);
    return { stale: attachment.stale };
  }

  /** Reruns one plugin's open for a live session, as the reopen the same change would cause. */
  private async replay(
    plugin: SessionOpenPlugin,
    input: SessionOpenWireRequest,
  ): Promise<Contribution> {
    const contribution = (output: SessionOpenWireRequest, failed: boolean): Contribution => ({
      pluginId: plugin.id,
      pluginInstanceId: plugin.instanceId,
      input,
      output,
      tools: stampTools(plugin, output.tools),
      synced: true,
      failed,
    });
    try {
      return contribution(await plugin.open({ ...input, reason: "refresh" }), false);
    } catch (error) {
      // Recorded under the new instance with no tools, so later requests do not wait on it again. The reopen
      // reruns the callback and reports its error.
      this.logger.warn(
        { err: error, pluginId: plugin.id, agentId: input.agentId },
        "Plugin session refresh failed",
      );
      return contribution(input, true);
    }
  }

  /**
   * A replayed plugin whose tool takes a name already in use keeps no tools; the reopen reports the collision. A name
   * stays with the plugin that has it in the session's record, whatever the plugin order.
   */
  private async dropCollidingTools({
    agentId,
    owners,
    contributions,
    replayed,
    options,
  }: CollisionCheck): Promise<void> {
    if (replayed.every(({ contribution }) => contribution.tools.length === 0)) return;
    const changed = new Set(replayed.map(({ contribution }) => contribution));
    const taken = new Set(await options.reservedToolNames());
    for (const contribution of contributions) {
      if (!changed.has(contribution)) for (const tool of contribution.tools) taken.add(tool.name);
    }
    // The previous owner keeps a name only while it still returns that tool.
    const ownedElsewhere = (contribution: Contribution, name: string) => {
      const owner = owners.get(name);
      if (owner === undefined || owner === contribution.pluginId) return false;
      return contributions.some(
        (other) => other.pluginId === owner && other.tools.some((tool) => tool.name === name),
      );
    };
    for (const contribution of changed) {
      const conflict = contribution.tools.find(
        (tool) => taken.has(tool.name) || ownedElsewhere(contribution, tool.name),
      );
      if (conflict) {
        this.logger.warn(
          { agentId, pluginId: contribution.pluginId, tool: conflict.name },
          "Refreshed plugin tool collides with another agent tool",
        );
        contribution.tools = [];
        contribution.failed = true;
        continue;
      }
      for (const tool of contribution.tools) taken.add(tool.name);
    }
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

interface CollisionCheck {
  agentId: string;
  /** Which plugin has each tool name in the session's record before this refresh. */
  owners: ReadonlyMap<string, string>;
  contributions: Contribution[];
  replayed: { contribution: Contribution }[];
  options: PluginSessionRefreshOptions;
}

function toolOwners(contributions: readonly Contribution[]): Map<string, string> {
  return new Map(
    contributions.flatMap((contribution) =>
      contribution.tools.map((tool) => [tool.name, contribution.pluginId] as const),
    ),
  );
}

/**
 * A recorded contribution stands for the plugin's callback in a reopen while the plugin runs the same instance, holds
 * the tools in its process, and would receive the same env and instructions from the plugins before it.
 */
function isReusable(
  contribution: Contribution,
  plugin: SessionOpenPlugin,
  incoming: SessionOpenWireRequest,
): boolean {
  return (
    contribution.synced &&
    contribution.pluginInstanceId === plugin.instanceId &&
    isDeepStrictEqual(chainedFields(contribution.input), chainedFields(incoming))
  );
}

/**
 * The fields one plugin's callback passes on to the next, including the launch wrap an earlier plugin selected. Tools
 * and MCP servers are collected per plugin instead.
 */
function chainedFields(request: SessionOpenWireRequest) {
  return {
    env: request.env,
    appendSystemPrompt: request.appendSystemPrompt ?? [],
    wrap: request.wrap ?? null,
  };
}

/**
 * What the provider launches with when the session opens with these contributions, in open order. Throws when two
 * plugins return the same MCP server name.
 */
function composeLaunch(
  base: SessionOpenWireRequest,
  contributions: readonly Contribution[],
): PluginSessionOpenResult {
  const mcpServers: SessionOpenWireRequest["mcpServers"] = {};
  const mcpServerOwners: Record<string, string> = {};
  for (const contribution of contributions) {
    collectMcpServers(
      mcpServers,
      mcpServerOwners,
      contribution.pluginId,
      contribution.output.mcpServers,
    );
  }
  return {
    ...(contributions.at(-1)?.output ?? base),
    tools: contributions.flatMap((contribution) => contribution.tools),
    mcpServers,
    mcpServerOwners,
  };
}

/**
 * Whether the proposed contributions launch the session as it runs now. A tool's plugin counts, since native-tool
 * catalogs dispatch to it; its instance does not. A launch the open would reject never matches, so the reopen
 * reports it.
 */
function launchesMatch(
  base: SessionOpenWireRequest,
  launched: readonly Contribution[],
  proposed: readonly Contribution[],
): boolean {
  let next: PluginSessionOpenResult;
  try {
    next = composeLaunch(base, proposed);
  } catch {
    return false;
  }
  return isDeepStrictEqual(launchContract(composeLaunch(base, launched)), launchContract(next));
}

function launchContract(launch: PluginSessionOpenResult) {
  return {
    ...chainedFields(launch),
    mcpServers: launch.mcpServers,
    tools: launch.tools.map(({ pluginId, name, title, description, inputSchema }) => ({
      pluginId,
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
        `Plugin ${pluginId} agent.open.before failed: MCP server ${name} from plugin ${pluginId} collides with plugin ${owners[name]}`,
      );
    }
    servers[name] = server;
    owners[name] = pluginId;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
