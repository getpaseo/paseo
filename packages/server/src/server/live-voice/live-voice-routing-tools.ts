import {
  LiveVoiceJsonObjectSchema,
  VoiceLiveRouteHostSchema,
  type VoiceLiveRouteHost,
} from "@getpaseo/protocol/live-voice-routing";
import { z } from "zod";
import type { LiveVoiceRouteBroker } from "./live-voice-route-broker.js";
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
const DISCOVERY_TIMEOUT_MS = 30_000;

const WorkspaceRowSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().nullish(),
  cwd: z.string().nullish(),
});

const LiveVoiceWorkspaceMatchSchema = z.object({
  serverId: z.string(),
  hostLabel: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  matchKind: z.enum(["exact", "partial"]),
});

const UnavailableHostSchema = z.object({
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

export function registerLiveVoiceRoutingTools(options: RegisterLiveVoiceRoutingToolsOptions): void {
  async function listHosts(): Promise<VoiceLiveRouteHost[]> {
    const result = await options.broker.execute(
      options.hostAgentId,
      { kind: "list_hosts" },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    if (result.kind !== "list_hosts") {
      throw new Error(`Unexpected routed result '${result.kind}' for list_hosts`);
    }
    return result.hosts;
  }

  async function listWorkspacesOnHost(
    host: VoiceLiveRouteHost,
  ): Promise<LiveVoiceWorkspaceCandidate[]> {
    const result = await options.broker.execute(
      options.hostAgentId,
      {
        kind: "execute_tool",
        targetServerId: host.serverId,
        toolName: "list_workspaces",
        arguments: {},
      },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    if (result.kind !== "execute_tool") {
      throw new Error(`Unexpected routed result '${result.kind}' for list_workspaces`);
    }
    const structured = result.toolResult.structuredContent;
    const rows =
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? z
            .array(WorkspaceRowSchema)
            .catch([])
            .parse((structured as { workspaces?: unknown }).workspaces)
        : [];
    return rows.map((row) => ({
      serverId: host.serverId,
      hostLabel: host.label,
      workspaceId: row.workspaceId,
      title: row.title ?? null,
      cwd: row.cwd ?? null,
    }));
  }

  options.registerTool(
    "list_hosts",
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
        structuredContent: { hosts: await listHosts() },
      };
    },
  );

  options.registerTool(
    "find_workspace",
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
        unavailableHosts: z.array(UnavailableHostSchema),
      },
    },
    async (input) => {
      const parsed = z
        .object({
          query: z.string().trim().min(1),
          serverId: z.string().trim().min(1).optional(),
        })
        .parse(input);

      const hosts = await listHosts();
      const requested = parsed.serverId
        ? hosts.filter((host) => host.serverId === parsed.serverId)
        : hosts;
      if (parsed.serverId && requested.length === 0) {
        throw new Error(`Unknown host '${parsed.serverId}'. Call list_hosts for the current list.`);
      }

      const unavailableHosts = requested
        .filter((host) => !isReadyHost(host))
        .map((host) => ({
          serverId: host.serverId,
          label: host.label,
          reason: describeUnreadyHost(host),
        }));
      const readyHosts = requested.filter(isReadyHost);

      // One round trip per host, all in flight together: the call waits for the
      // slowest host rather than for the sum of them.
      const listings = await Promise.allSettled(readyHosts.map(listWorkspacesOnHost));
      const candidates: LiveVoiceWorkspaceCandidate[] = [];
      const searchedHosts: Array<{ serverId: string; label: string }> = [];
      listings.forEach((listing, index) => {
        const host = readyHosts[index];
        if (!host) {
          return;
        }
        if (listing.status === "fulfilled") {
          candidates.push(...listing.value);
          searchedHosts.push({ serverId: host.serverId, label: host.label });
          return;
        }
        // A host that failed to answer is reported, never folded into "no
        // match" — the workspace the user asked for may well be on it.
        unavailableHosts.push({
          serverId: host.serverId,
          label: host.label,
          reason: errorMessage(listing.reason),
        });
      });

      const search = searchLiveVoiceWorkspaces(parsed.query, candidates);
      return {
        content: [],
        structuredContent: {
          resolution: search.resolution,
          matches: search.matches,
          searchedHosts,
          unavailableHosts,
        },
      };
    },
  );

  options.registerTool(
    "list_paseo_tools_on_host",
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
    "run_paseo_tool_on_host",
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
