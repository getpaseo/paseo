export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface PiPromptAck {
  agentInvoked?: boolean;
}

export interface PiPromptAck {
  requestId?: string;
  agentInvoked?: boolean;
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCallContent;

export type PiAgentMessage =
  | {
      role: "user";
      content: string | Array<PiTextContent | PiImageContent>;
    }
  | {
      role: "custom";
      content: string | Array<PiTextContent | PiImageContent>;
    }
  | {
      role: "assistant";
      content: PiAssistantContent[];
      provider?: string;
      model?: string;
      responseId?: string;
      responseModel?: string;
      errorMessage?: string | null;
      stopReason?: string;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError?: boolean;
      details?: unknown;
    }
  | {
      role: "bashExecution";
      command: string;
      output?: string;
      exitCode?: number | null;
      cancelled?: boolean;
      timestamp: number;
    };

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  api?: string;
  baseUrl?: string;
  input?: string[];
  cost?: Record<string, unknown>;
  compat?: unknown;
}

export interface PiSessionState {
  model?: PiModel | null;
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled?: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  };
  todoPhases?: unknown;
}

export interface PiSessionStats {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  };
}

export interface PiRpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: Record<string, unknown>;
  input?: { hint?: string };
}

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: PiImageContent[] }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_thinking_level"; level: PiThinkingLevel }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: string };

export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type PiAssistantMessageEvent =
  | { type: "start"; contentIndex?: number }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta?: string }
  | { type: "text_end"; contentIndex: number; content?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta?: string }
  | { type: "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta?: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall?: unknown }
  | { type: "done"; contentIndex?: number };

export type PiAgentSessionEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: PiAgentMessage }
  | { type: "message_end"; message: PiAgentMessage }
  | {
      type: "message_update";
      // COMPAT(piMessageUpdateDeltas): Pi >=0.84 emits only `assistantMessageEvent`
      // deltas — the cumulative `message` field was removed (pi #7290). Older
      // binaries still include it. Remove the optional field after the supported
      // pi floor includes 0.84.
      message?: PiAgentMessage;
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: "compaction_start"; reason?: "manual" | "threshold" | "overflow" | string }
  | { type: "compaction_end"; reason?: string; errorMessage?: string; aborted?: boolean }
  | { type: "agent_end"; messages?: PiAgentMessage[] };

export type PiRuntimeEvent =
  | PiAgentSessionEvent
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      [key: string]: unknown;
    }
  | {
      type: "command_output";
      text?: string;
    }
  | {
      type: "process_exit";
      error: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };
