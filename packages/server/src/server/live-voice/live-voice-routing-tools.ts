import {
  LiveVoiceJsonObjectSchema,
  VoiceLiveRouteHostSchema,
  type LiveVoiceJsonObject,
  type VoiceLiveRouteHost,
} from "@getpaseo/protocol/live-voice-routing";
import { z } from "zod";
import {
  LiveVoiceRoutedRequestError,
  type LiveVoiceRouteBroker,
} from "./live-voice-route-broker.js";
import {
  canRunOnAllLiveVoiceHosts,
  LIVE_VOICE_ALL_HOSTS_READ_TOOLS,
} from "./live-voice-fanout-tools.js";
import {
  searchLiveVoiceWorkspaces,
  type LiveVoiceWorkspaceCandidate,
} from "./live-voice-workspace-search.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

/**
 * Discovery must not inherit the broker's ten-minute default. That timeout is
 * sized for tools that wait on an agent turn; a host that goes quiet mid-search
 * would otherwise hold the whole call silent for ten minutes.
 */
const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Saved hosts change when the user edits them, not mid-sentence. Without this,
 * every fan-out pays a serial round trip through the owning app — possibly on
 * cellular — before any target is contacted. Stale entries self-correct: a host
 * that has since gone away fails its own read and is reported by name, and an
 * explicitly named host missing from the cache triggers one fresh fetch.
 */
const HOSTS_CACHE_TTL_MS = 30_000;

const WorkspaceRowSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().nullish(),
  cwd: z.string().nullish(),
});

const WorkspaceListingSchema = z.object({
  workspaces: z.array(WorkspaceRowSchema),
});

const LiveVoiceWorkspaceMatchSchema = z.object({
  serverId: z.string(),
  hostLabel: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  matchKind: z.enum(["exact", "partial"]),
});

/** One host, one sentence about why it has no result. Used for both failure buckets. */
const HostReportSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  reason: z.string(),
});

export interface RegisterLiveVoiceRoutingToolsOptions {
  hostAgentId: string;
  broker: Pick<LiveVoiceRouteBroker, "execute">;
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
}

export const LIVE_VOICE_ROUTING_TOOL_NAMES = {
  listHosts: "list_hosts",
  findWorkspace: "find_workspace",
  runOnAllHosts: "run_paseo_tool_on_all_hosts",
  listToolsOnHost: "list_paseo_tools_on_host",
  runOnHost: "run_paseo_tool_on_host",
} as const;

export const LIVE_VOICE_ROUTING_TOOLS = Object.values(LIVE_VOICE_ROUTING_TOOL_NAMES);

/**
 * `compatibility` is optional so a client too old to send it still routes. Fall
 * back to the two facts every version reports.
 */
function isReadyHost(host: VoiceLiveRouteHost): boolean {
  return host.compatibility === undefined
    ? host.online && host.toolExecutionSupported
    : host.compatibility === "ready";
}

/** Read from the same field readiness was decided by, so the two cannot disagree. */
function describeUnreadyHost(host: VoiceLiveRouteHost): string {
  if (host.compatibility !== undefined) {
    return host.compatibility === "offline" ? "offline" : "needs a Paseo upgrade";
  }
  return host.online ? "needs a Paseo upgrade" : "offline";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codes the app produces before the target daemon runs anything, plus
 * `target_request_failed` for a transport that broke mid-request. Everything
 * else — the executor's own codes and any code a newer peer invents — means the
 * host answered, so it is classified as a tool failure. That is the safer wrong
 * guess for an unknown code: "that read failed on Desktop" is mildly off when
 * the host was in fact unreachable, but "I could not see Desktop" when the host
 * answered fine claims an outage that is not happening.
 */
const UNREACHABLE_ROUTE_CODES = new Set([
  "host_offline",
  "unknown_host",
  "tool_execution_unsupported",
  "agent_notifications_unsupported",
  "unauthorized_source_call",
  "target_request_failed",
  "router_timeout",
  "router_send_failed",
  "router_unavailable",
  "route_closed",
]);

function isUnreachableFailure(error: unknown): boolean {
  if (error instanceof LiveVoiceRoutedRequestError) {
    return UNREACHABLE_ROUTE_CODES.has(error.code);
  }
  // No response ever arrived: broker timeout, send failure, call teardown.
  return true;
}

interface HostReport {
  serverId: string;
  label: string;
  reason: string;
}

function toHostReport(host: VoiceLiveRouteHost, reason: string): HostReport {
  return { serverId: host.serverId, label: host.label, reason };
}

/** A tool that reports failure via `isError` puts the explanation in its text content. */
function describeIsErrorResult(content: unknown): string {
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return (item as { text: string }).text;
      }
    }
  }
  return "the tool reported an error";
}

export function registerLiveVoiceRoutingTools(options: RegisterLiveVoiceRoutingToolsOptions): void {
  let cachedHosts: { hosts: VoiceLiveRouteHost[]; expiresAt: number } | null = null;

  async function listHostsFresh(): Promise<VoiceLiveRouteHost[]> {
    const result = await options.broker.execute(
      options.hostAgentId,
      { kind: "list_hosts" },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    if (result.kind !== "list_hosts") {
      throw new Error(`Unexpected routed result '${result.kind}' for list_hosts`);
    }
    cachedHosts = { hosts: result.hosts, expiresAt: Date.now() + HOSTS_CACHE_TTL_MS };
    return result.hosts;
  }

  async function listHostsCached(): Promise<VoiceLiveRouteHost[]> {
    if (cachedHosts && Date.now() < cachedHosts.expiresAt) {
      return cachedHosts.hosts;
    }
    return listHostsFresh();
  }

  async function runOnHost(
    host: VoiceLiveRouteHost,
    toolName: string,
    args: LiveVoiceJsonObject,
  ): Promise<{ structuredContent: unknown; content: unknown; isError: boolean }> {
    const result = await options.broker.execute(
      options.hostAgentId,
      {
        kind: "execute_tool",
        targetServerId: host.serverId,
        toolName,
        arguments: args,
      },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    if (result.kind !== "execute_tool") {
      throw new Error(`Unexpected routed result '${result.kind}' for ${toolName}`);
    }
    return {
      structuredContent: result.toolResult.structuredContent ?? null,
      content: result.toolResult.content,
      isError: result.toolResult.isError === true,
    };
  }

  interface FanOutSuccess {
    host: VoiceLiveRouteHost;
    structuredContent: unknown;
  }

  interface FanOutOutcome {
    successes: FanOutSuccess[];
    searchedHosts: Array<{ serverId: string; label: string }>;
    /** Could not be reached at all: offline, needs upgrade, route died. */
    unavailableHosts: HostReport[];
    /** Answered, and this particular tool failed there. Not an outage. */
    erroredHosts: HostReport[];
  }

  /**
   * One read, every ready host, one model turn. The hops are cheap; the turn the
   * user waits through is not, so nothing here is sequential.
   *
   * Every host lands in exactly one bucket. The two failure buckets exist
   * because a voice call narrates them differently: an unreachable machine is
   * "I could not see it", a tool error is "it answered but this read failed" —
   * and an agent-scoped read fanned out to find which machine owns the agent
   * *expects* clean failures everywhere but one.
   */
  async function fanOut(input: {
    toolName: string;
    arguments: LiveVoiceJsonObject;
    serverId?: string | undefined;
  }): Promise<FanOutOutcome> {
    let hosts = await listHostsCached();
    if (input.serverId && !hosts.some((host) => host.serverId === input.serverId)) {
      // The named host may have been saved after the cache was filled.
      hosts = await listHostsFresh();
    }
    const requested = input.serverId
      ? hosts.filter((host) => host.serverId === input.serverId)
      : hosts;
    if (input.serverId && requested.length === 0) {
      throw new Error(`Unknown host '${input.serverId}'. Call list_hosts for the current list.`);
    }

    const unavailableHosts = requested
      .filter((host) => !isReadyHost(host))
      .map((host) => toHostReport(host, describeUnreadyHost(host)));
    const erroredHosts: HostReport[] = [];
    const readyHosts = requested.filter(isReadyHost);

    const settled = await Promise.allSettled(
      readyHosts.map((host) => runOnHost(host, input.toolName, input.arguments)),
    );
    const successes: FanOutSuccess[] = [];
    const searchedHosts: Array<{ serverId: string; label: string }> = [];
    settled.forEach((outcome, index) => {
      const host = readyHosts[index];
      if (!host) {
        return;
      }
      if (outcome.status === "fulfilled") {
        if (outcome.value.isError) {
          erroredHosts.push(toHostReport(host, describeIsErrorResult(outcome.value.content)));
          return;
        }
        successes.push({ host, structuredContent: outcome.value.structuredContent });
        searchedHosts.push({ serverId: host.serverId, label: host.label });
        return;
      }
      // A host that failed is reported, never folded into an empty result —
      // what the user asked about may well be on it.
      const report = toHostReport(host, errorMessage(outcome.reason));
      if (isUnreachableFailure(outcome.reason)) {
        unavailableHosts.push(report);
      } else {
        erroredHosts.push(report);
      }
    });
    return { successes, searchedHosts, unavailableHosts, erroredHosts };
  }

  options.registerTool(
    LIVE_VOICE_ROUTING_TOOL_NAMES.listHosts,
    {
      title: "List connected hosts",
      description:
        "List the user's Paseo hosts visible to this voice call. Execute only on compatibility=ready; explain that upgrade_required hosts need a Paseo upgrade. Use the opaque serverId with list_paseo_tools_on_host and run_paseo_tool_on_host. Host endpoints and credentials are never exposed. When the user names a workspace, call find_workspace instead — it searches every ready host in one call.",
      inputSchema: {},
      outputSchema: { hosts: z.array(VoiceLiveRouteHostSchema) },
    },
    async () => {
      return {
        content: [],
        structuredContent: { hosts: await listHostsFresh() },
      };
    },
  );

  options.registerTool(
    LIVE_VOICE_ROUTING_TOOL_NAMES.findWorkspace,
    {
      title: "Find a workspace by name",
      description:
        "Resolve a workspace the user named out loud into the exact serverId and workspaceId needed to act on it, searching every ready host at once. Use this instead of list_hosts followed by list_workspaces whenever the user names a workspace. Read the returned resolution before acting: unique_exact identifies one workspace and is safe to act on; ambiguous_exact means several workspaces share that name, so ask which host or directory the user meant; unique_partial and ambiguous_partial mean nothing matched exactly, so confirm before acting; none means no workspace matched. Never guess between matches for archiving or any other destructive action. Pass the returned serverId and workspaceId straight to run_paseo_tool_on_host.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The workspace name as the user said it. Matching ignores case, punctuation and hyphens, and covers both the title and the directory name.",
          ),
        serverId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Search only this host. Omit to search every ready host."),
      },
      outputSchema: {
        resolution: z.enum([
          "unique_exact",
          "ambiguous_exact",
          "unique_partial",
          "ambiguous_partial",
          "none",
        ]),
        matches: z.array(LiveVoiceWorkspaceMatchSchema),
        searchedHosts: z.array(z.object({ serverId: z.string(), label: z.string() })),
        unavailableHosts: z.array(HostReportSchema),
        erroredHosts: z.array(HostReportSchema),
      },
    },
    async (input) => {
      const parsed = z
        .object({
          query: z.string().trim().min(1),
          serverId: z.string().trim().min(1).optional(),
        })
        .parse(input);

      const outcome = await fanOut({
        toolName: "list_workspaces",
        arguments: {},
        serverId: parsed.serverId,
      });
      // A host whose listing does not parse was not searched, whatever it sent
      // back. Counting it as "searched, empty" would let a version-skewed host
      // silently hide the workspace the user just named.
      const candidates: LiveVoiceWorkspaceCandidate[] = [];
      const searchedHosts: Array<{ serverId: string; label: string }> = [];
      const erroredHosts = [...outcome.erroredHosts];
      for (const success of outcome.successes) {
        const listing = WorkspaceListingSchema.safeParse(success.structuredContent);
        if (!listing.success) {
          erroredHosts.push(
            toHostReport(success.host, "returned a workspace list this call could not read"),
          );
          continue;
        }
        searchedHosts.push({ serverId: success.host.serverId, label: success.host.label });
        candidates.push(
          ...listing.data.workspaces.map((row) => ({
            serverId: success.host.serverId,
            hostLabel: success.host.label,
            workspaceId: row.workspaceId,
            title: row.title ?? null,
            cwd: row.cwd ?? null,
          })),
        );
      }
      const search = searchLiveVoiceWorkspaces(parsed.query, candidates);
      return {
        content: [],
        structuredContent: {
          resolution: search.resolution,
          matches: search.matches,
          searchedHosts,
          unavailableHosts: outcome.unavailableHosts,
          erroredHosts,
        },
      };
    },
  );

  options.registerTool(
    LIVE_VOICE_ROUTING_TOOL_NAMES.runOnAllHosts,
    {
      title: "Run a Paseo read on every host",
      description: `Run one read-only Paseo tool on every ready host at once and get the results per host, in a single call. Use this for any question about the user's machines as a whole — what is running anywhere, what is waiting on permission anywhere — instead of calling list_hosts and then run_paseo_tool_on_host once per machine. Also use it to locate something by id: fanning get_agent_status out is how to learn which machine owns an agent, and the machines that do not will report a tool error, not an outage. Only these tools can be run this way: ${LIVE_VOICE_ALL_HOSTS_READ_TOOLS.join(", ")}. Anything that changes state runs on one named host through run_paseo_tool_on_host, so the user is never asked one question that mutates several machines. unavailableHosts could not be reached at all; erroredHosts answered but this read failed there — never present either as the machine holding nothing.`,
      inputSchema: {
        toolName: z
          .string()
          .trim()
          .min(1)
          .describe("A read-only Paseo tool name from the list in this description."),
        arguments: LiveVoiceJsonObjectSchema.optional().describe(
          "Arguments for the target tool, applied identically on every host. Omit when it takes none.",
        ),
      },
      outputSchema: {
        toolName: z.string(),
        results: z.array(
          z.object({
            serverId: z.string(),
            hostLabel: z.string(),
            result: LiveVoiceJsonObjectSchema.nullable(),
          }),
        ),
        unavailableHosts: z.array(HostReportSchema),
        erroredHosts: z.array(HostReportSchema),
      },
    },
    async (input) => {
      const parsed = z
        .object({
          toolName: z.string().trim().min(1),
          arguments: LiveVoiceJsonObjectSchema.optional(),
        })
        .parse(input);
      if (!canRunOnAllLiveVoiceHosts(parsed.toolName)) {
        throw new Error(
          `'${parsed.toolName}' cannot be run on every host at once. Run it on one host with run_paseo_tool_on_host, or fan out one of: ${LIVE_VOICE_ALL_HOSTS_READ_TOOLS.join(", ")}.`,
        );
      }

      const outcome = await fanOut({
        toolName: parsed.toolName,
        arguments: parsed.arguments ?? {},
      });
      return {
        content: [],
        structuredContent: {
          toolName: parsed.toolName,
          results: outcome.successes.map((success) => ({
            serverId: success.host.serverId,
            hostLabel: success.host.label,
            result: success.structuredContent ?? null,
          })),
          unavailableHosts: outcome.unavailableHosts,
          erroredHosts: outcome.erroredHosts,
        },
      };
    },
  );

  options.registerTool(
    LIVE_VOICE_ROUTING_TOOL_NAMES.listToolsOnHost,
    {
      title: "Discover Paseo tools on host",
      description:
        "Describe an ordinary Paseo tool available on one ready host. This is a fallback for a tool you do not already know: the common tool names are given to you up front, and run_paseo_tool_on_host accepts them directly. Prefer an exact toolName; query is a keyword filter, not a sentence.",
      inputSchema: {
        serverId: z.string().trim().min(1),
        toolName: z.string().trim().min(1).optional(),
        query: z.string().trim().min(1).optional(),
      },
    },
    async (input) => {
      const parsed = z
        .object({
          serverId: z.string().trim().min(1),
          toolName: z.string().trim().min(1).optional(),
          query: z.string().trim().min(1).optional(),
        })
        .parse(input);
      const result = await options.broker.execute(options.hostAgentId, {
        kind: "execute_tool",
        targetServerId: parsed.serverId,
        toolName: "list_paseo_tools",
        arguments: {
          ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
          ...(parsed.query ? { query: parsed.query } : {}),
        },
      });
      if (result.kind !== "execute_tool") {
        throw new Error(`Unexpected routed result '${result.kind}' for list_paseo_tools_on_host`);
      }
      return {
        content: [],
        structuredContent: {
          targetServerId: result.targetServerId,
          tools:
            result.toolResult.structuredContent &&
            typeof result.toolResult.structuredContent === "object" &&
            !Array.isArray(result.toolResult.structuredContent) &&
            "tools" in result.toolResult.structuredContent
              ? result.toolResult.structuredContent.tools
              : [],
        },
      };
    },
  );

  options.registerTool(
    LIVE_VOICE_ROUTING_TOOL_NAMES.runOnHost,
    {
      title: "Run Paseo tool on host",
      description:
        "Run one ordinary top-level Paseo tool on a ready host. Call it directly with a tool name you already know; reach for list_paseo_tools_on_host only for one you do not. When the target is a workspace the user named, take its serverId and workspaceId from find_workspace rather than listing hosts and workspaces yourself. Pass only the target tool's arguments. Background agent work is tracked automatically and reports completion, errors, or permission requests. Never ask for or pass host credentials or network endpoints.",
      inputSchema: {
        serverId: z.string().trim().min(1),
        toolName: z.string().trim().min(1),
        arguments: LiveVoiceJsonObjectSchema,
      },
    },
    async (input) => {
      const parsed = z
        .object({
          serverId: z.string().trim().min(1),
          toolName: z.string().trim().min(1),
          arguments: LiveVoiceJsonObjectSchema,
        })
        .parse(input);
      const result = await options.broker.execute(options.hostAgentId, {
        kind: "execute_tool",
        targetServerId: parsed.serverId,
        toolName: parsed.toolName,
        arguments: parsed.arguments,
        notifyOnAgentFinish: true,
      });
      if (result.kind !== "execute_tool") {
        throw new Error(`Unexpected routed result '${result.kind}' for run_paseo_tool_on_host`);
      }
      return {
        content: z
          .array(
            z
              .object({
                type: z.string().min(1),
                text: z.string().optional(),
              })
              .passthrough(),
          )
          .parse(result.toolResult.content),
        structuredContent: {
          targetServerId: result.targetServerId,
          result: result.toolResult.structuredContent ?? null,
        },
        ...(result.toolResult.isError === undefined ? {} : { isError: result.toolResult.isError }),
      };
    },
  );
}
