import { v4 as uuidv4 } from "uuid";
import { readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { getSystemPrompt } from "./system-prompt.js";
import { streamLLM, type Message } from "./llm-openai.js";
import { generateTTSAndWaitForPlayback } from "./tts-manager.js";
import type { VoiceAssistantWebSocketServer } from "../websocket-server.js";
import type { ArtifactPayload } from "../types.js";

const execAsync = promisify(exec);

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
  // Track pending TTS playback promise outside of streamLLM scope
  let pendingTTS: Promise<void> | null = null;

  try {
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

        // Handle present_artifact tool specially
        if (toolName === "present_artifact" && params.wsServer) {
          const artifactId = uuidv4();

          // Resolve source to content
          let content: string;
          let isBase64 = false;
          try {
            if (args.source.type === "file") {
              const fileBuffer = await readFile(args.source.path);
              content = fileBuffer.toString("base64");
              isBase64 = true;
            } else if (args.source.type === "command_output") {
              const { stdout } = await execAsync(args.source.command, { encoding: 'buffer' });
              content = stdout.toString("base64");
              isBase64 = true;
            } else if (args.source.type === "text") {
              content = args.source.text;
              isBase64 = false;
            } else {
              content = "[Unknown source type]";
              isBase64 = false;
            }
          } catch (error) {
            console.error("Failed to resolve artifact source:", error);
            content = `[Error resolving source: ${error instanceof Error ? error.message : String(error)}]`;
            isBase64 = false;
          }

          const artifact: ArtifactPayload = {
            type: args.type,
            id: artifactId,
            title: args.title,
            content,
            isBase64,
          };

          // Broadcast artifact to client
          params.wsServer.broadcast({
            type: "artifact",
            payload: artifact,
          });

          // Broadcast as activity log entry so it appears in the feed
          params.wsServer.broadcastActivityLog({
            id: artifactId,
            timestamp: new Date(),
            type: "system",
            content: `${args.type} artifact: ${args.title}`,
            metadata: { artifactId, artifactType: args.type },
          });
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
        // Don't wait for TTS here - we'll handle it after adding to history
      },
    });

    // Add assistant response to context IMMEDIATELY after stream completes
    // This ensures partial responses are saved even if TTS fails or is interrupted
    conversation.messages.push({
      role: "assistant",
      content: assistantResponse,
    });

    // Now wait for any pending TTS, but don't fail the entire operation if it times out
    if (pendingTTS) {
      try {
        await pendingTTS;
      } catch (ttsError) {
        // TTS failed but message is already in history - just log the error
        console.error("TTS playback failed (message already saved):", ttsError);
      }
    }
  } catch (error) {
    // If stream itself failed or was aborted, still save any partial response to history
    if (assistantResponse) {
      conversation.messages.push({
        role: "assistant",
        content: assistantResponse,
      });
    }

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

