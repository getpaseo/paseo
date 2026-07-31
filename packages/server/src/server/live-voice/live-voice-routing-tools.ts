import {
  LiveVoiceJsonObjectSchema,
  VoiceLiveRouteHostSchema,
} from "@getpaseo/protocol/live-voice-routing";
import { z } from "zod";
import type { LiveVoiceRouteBroker } from "./live-voice-route-broker.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

export interface RegisterLiveVoiceRoutingToolsOptions {
  hostAgentId: string;
  broker: Pick<LiveVoiceRouteBroker, "execute">;
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
}

export function registerLiveVoiceRoutingTools(options: RegisterLiveVoiceRoutingToolsOptions): void {
  options.registerTool(
    "list_hosts",
    {
      title: "List connected hosts",
      description:
        "List the user's Paseo hosts visible to this voice call. Execute only on compatibility=ready; explain that upgrade_required hosts need a Paseo upgrade. Use the opaque serverId with list_paseo_tools_on_host and run_paseo_tool_on_host. Host endpoints and credentials are never exposed.",
      inputSchema: {},
      outputSchema: { hosts: z.array(VoiceLiveRouteHostSchema) },
    },
    async () => {
      const result = await options.broker.execute(options.hostAgentId, {
        kind: "list_hosts",
      });
      if (result.kind !== "list_hosts") {
        throw new Error(`Unexpected routed result '${result.kind}' for list_hosts`);
      }
      return {
        content: [],
        structuredContent: { hosts: result.hosts },
      };
    },
  );

  options.registerTool(
    "list_paseo_tools_on_host",
    {
      title: "Discover Paseo tools on host",
      description:
        "List or describe ordinary Paseo tools available on one ready host. Use this before run_paseo_tool_on_host instead of guessing tool names or arguments.",
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
        "Run one ordinary top-level Paseo tool on a ready host. Call list_hosts and list_paseo_tools_on_host first; do not guess tool names or arguments. Pass only the target tool's arguments. Background agent work is tracked automatically and reports completion, errors, or permission requests. Never ask for or pass host credentials or network endpoints.",
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
