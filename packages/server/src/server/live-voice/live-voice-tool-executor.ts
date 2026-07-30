import {
  VoiceLiveToolResultSchema,
  VoiceLiveToolExecuteResponseSchema,
  type VoiceLiveToolExecuteRequest,
  type VoiceLiveToolExecuteResponse,
} from "@getpaseo/protocol/live-voice-routing";
import type { PaseoToolCatalogFactory } from "../agent/tools/types.js";
import { ensureValidJson } from "../json-utils.js";

export interface LiveVoiceToolExecutorOptions {
  createCatalog: PaseoToolCatalogFactory;
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

  async execute(request: VoiceLiveToolExecuteRequest): Promise<VoiceLiveToolExecuteResponse> {
    try {
      const catalog = await this.createCatalog({});
      const toolResult = VoiceLiveToolResultSchema.parse(
        ensureValidJson(await catalog.executeTool(request.toolName, request.arguments)),
      );
      return VoiceLiveToolExecuteResponseSchema.parse({
        type: "voice.live.tool.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          toolResult,
        },
      });
    } catch (error) {
      return VoiceLiveToolExecuteResponseSchema.parse({
        type: "voice.live.tool.execute.response",
        payload: {
          requestId: request.requestId,
          ok: false,
          error: {
            code: "tool_execution_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        },
      });
    }
  }
}
