import { LiveVoiceJsonObjectSchema } from "@getpaseo/protocol/live-voice-routing";
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
        "List the user's Paseo hosts visible to the client that owns this voice call. Use the opaque serverId from this result with run_paseo_tool_on_host. Host connection endpoints and credentials are intentionally never exposed.",
      inputSchema: {},
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
    "run_paseo_tool_on_host",
    {
      title: "Run Paseo tool on host",
      description:
        "Run one ordinary top-level Paseo tool on a connected host. Call list_hosts first and pass its exact opaque serverId. Pass only the target tool's arguments; never ask for or pass host credentials or network endpoints.",
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
        ...(result.toolResult.structuredContent === undefined
          ? {}
          : { structuredContent: result.toolResult.structuredContent }),
        ...(result.toolResult.isError === undefined ? {} : { isError: result.toolResult.isError }),
      };
    },
  );
}
