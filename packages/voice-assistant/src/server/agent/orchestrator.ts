import { v4 as uuidv4 } from "uuid";
import { getSystemPrompt } from "./system-prompt.js";
import { streamLLM, type Message } from "./llm-openai.js";
import { generateTTSAndWaitForPlayback } from "./tts-manager.js";
import type { VoiceAssistantWebSocketServer } from "../websocket-server.js";

interface ConversationContext {
  id: string;
  messages: Message[];
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Store active conversations (in-memory for now)
 * In production, this could be persisted to a database
 */
const conversations = new Map<string, ConversationContext>();

/**
 * Create a new conversation
 */
export function createConversation(): string {
  const id = uuidv4();
  conversations.set(id, {
    id,
    messages: [],
    createdAt: new Date(),
    lastActivity: new Date(),
  });
  return id;
}

/**
 * Get conversation by ID
 */
export function getConversation(id: string): ConversationContext | null {
  return conversations.get(id) || null;
}

/**
 * Delete a conversation by ID
 */
export function deleteConversation(id: string): void {
  conversations.delete(id);
}

/**
 * Process user message through the LLM orchestrator
 * Handles streaming, tool calls, and WebSocket broadcasting
 */
export async function processUserMessage(params: {
  conversationId: string;
  message: string;
  wsServer?: VoiceAssistantWebSocketServer;
  enableTTS?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const conversation = conversations.get(params.conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }

  // Add user message to context
  conversation.messages.push({
    role: "user",
    content: params.message,
  });
  conversation.lastActivity = new Date();

  // Note: User message is already broadcast by the caller (e.g., after STT in index.ts)
  // No need to broadcast again here to avoid duplication

  let assistantResponse = "";

  try {
    // Track pending TTS playback promise
    let pendingTTS: Promise<void> | null = null;

    // Stream LLM response with tool execution
    assistantResponse = await streamLLM({
      systemPrompt: getSystemPrompt(),
      messages: conversation.messages,
      abortSignal: params.abortSignal,
      onTextSegment: (segment) => {
        // Create TTS promise (don't await it yet)
        if (params.wsServer && params.enableTTS) {
          pendingTTS = generateTTSAndWaitForPlayback(segment, params.wsServer);
        }

        // Broadcast complete text segments
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: uuidv4(),
            timestamp: new Date(),
            type: "assistant",
            content: segment,
          });
        }
      },
      onChunk: async (chunk) => {
        params.wsServer?.broadcast({
          type: "assistant_chunk",
          payload: { chunk },
        });
      },
      onToolCall: async (toolCallId, toolName, args) => {
        if (pendingTTS) {
          console.log("Waiting for pending TTS to finish to execute", toolName);
          await pendingTTS;
          pendingTTS = null;
        }
        // Broadcast tool call to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: toolCallId,
            timestamp: new Date(),
            type: "tool_call",
            content: `Calling ${toolName}`,
            metadata: { toolCallId, toolName, arguments: args },
          });
        }
      },
      onToolResult: (toolCallId, toolName, result) => {
        // Broadcast tool result to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: toolCallId,
            timestamp: new Date(),
            type: "tool_result",
            content: `Tool ${toolName} completed`,
            metadata: { toolCallId, toolName, result },
          });
        }
      },
      onToolError: async (toolCallId, toolName, error) => {
        // Broadcast tool error to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: toolCallId,
            timestamp: new Date(),
            type: "error",
            content: `Tool ${toolName} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            metadata: { toolCallId, toolName, error },
          });
        }
      },
      onError: async (error) => {
        // Broadcast general stream error to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Stream error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      },
      onFinish: async () => {
        // Wait for any final pending TTS to complete
        if (pendingTTS) {
          await pendingTTS;
          pendingTTS = null;
        }
      },
    });

    // Add assistant response to context
    conversation.messages.push({
      role: "assistant",
      content: assistantResponse,
    });
  } catch (error) {
    // Broadcast error to WebSocket
    if (params.wsServer) {
      params.wsServer.broadcastActivityLog({
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    throw error;
  }

  return assistantResponse;
}

/**
 * Clean up old conversations (call periodically)
 */
export function cleanupConversations(maxAgeMinutes: number = 60): void {
  const now = new Date();
  for (const [id, conv] of conversations.entries()) {
    const ageMinutes =
      (now.getTime() - conv.lastActivity.getTime()) / (1000 * 60);
    if (ageMinutes > maxAgeMinutes) {
      conversations.delete(id);
    }
  }
}

/**
 * Get conversation statistics
 */
export function getConversationStats(): {
  total: number;
  conversations: Array<{
    id: string;
    messageCount: number;
    lastActivity: Date;
  }>;
} {
  return {
    total: conversations.size,
    conversations: Array.from(conversations.values()).map((conv) => ({
      id: conv.id,
      messageCount: conv.messages.length,
      lastActivity: conv.lastActivity,
    })),
  };
}
