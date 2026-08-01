import {
  VoiceLiveToolResultSchema,
  VoiceLiveToolExecuteResponseSchema,
  type VoiceLiveToolExecuteRequest,
  type VoiceLiveToolExecuteResponse,
} from "@getpaseo/protocol/live-voice-routing";
import type { PaseoToolCatalogFactory } from "../agent/tools/types.js";
import { ensureValidJson } from "../json-utils.js";
import { ZodError } from "zod";

export interface LiveVoiceToolExecutorOptions {
  createCatalog: PaseoToolCatalogFactory;
}

export interface LiveVoiceToolExecutionContext {
  /**
   * Supplied by the session that owns the requesting socket. Called when the
   * routed tool leaves an agent working, so the session can report its outcome
   * back to that socket and nowhere else.
   */
  onBackgroundAgentStarted?: (params: { agentId: string }) => void;
}

/**
 * Executes a client-routed request using the target daemon's ordinary top-level
 * Paseo catalog. There is intentionally no callerAgentId input: the wire cannot
 * claim agent ownership or inherit an agent's cwd/workspace authority.
 */
export class LiveVoiceToolExecutor {
  private readonly createCatalog: PaseoToolCatalogFactory;

  constructor(options: LiveVoiceToolExecutorOptions) {
    this.createCatalog = options.createCatalog;
  }

  async execute(
    request: VoiceLiveToolExecuteRequest,
    context: LiveVoiceToolExecutionContext = {},
  ): Promise<VoiceLiveToolExecuteResponse> {
    try {
      let backgroundAgentId: string | undefined;
      const catalog = await this.createCatalog(
        request.notifyOnAgentFinish === true && context.onBackgroundAgentStarted
          ? {
              onBackgroundAgentStarted: ({ agentId }) => {
                backgroundAgentId = agentId;
                context.onBackgroundAgentStarted?.({ agentId });
              },
              // A blocking call would strand this request: the voice model waits
              // in silence, the callback above never fires, and the outcome is
              // never reported. Reporting is the only channel this caller has,
              // so it cannot depend on the model passing `background` itself.
              defaultAgentWorkToBackground: true,
            }
          : {},
      );
      if (typeof catalog.getTool === "function" && !catalog.getTool(request.toolName)) {
        const suggestions = Array.from(catalog.tools?.keys?.() ?? [])
          .filter((name) => name.includes(request.toolName) || request.toolName.includes(name))
          .slice(0, 5);
        return VoiceLiveToolExecuteResponseSchema.parse({
          type: "voice.live.tool.execute.response",
          payload: {
            requestId: request.requestId,
            ok: false,
            error: {
              code: "tool_not_found",
              message: suggestions.length
                ? `Paseo tool not found: ${request.toolName}. Similar tools: ${suggestions.join(", ")}`
                : `Paseo tool not found: ${request.toolName}. Discover tools before executing.`,
              retryable: false,
            },
          },
        });
      }
      const toolResult = VoiceLiveToolResultSchema.parse(
        ensureValidJson(await catalog.executeTool(request.toolName, request.arguments)),
      );
      return VoiceLiveToolExecuteResponseSchema.parse({
        type: "voice.live.tool.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          toolResult,
          ...(backgroundAgentId ? { backgroundAgentId } : {}),
        },
      });
    } catch (error) {
      return VoiceLiveToolExecuteResponseSchema.parse({
        type: "voice.live.tool.execute.response",
        payload: {
          requestId: request.requestId,
          ok: false,
          error: {
            code: error instanceof ZodError ? "invalid_tool_arguments" : "tool_execution_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        },
      });
    }
  }
}
