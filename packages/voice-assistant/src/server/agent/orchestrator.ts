import { v4 as uuidv4 } from 'uuid';
import { getSystemPrompt } from './system-prompt.js';
import { streamLLM, type Message } from './llm-openai.js';
import type { VoiceAssistantWebSocketServer } from '../websocket-server.js';

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
 * Create a new conversation with system prompt
 */
export function createConversation(): string {
  const id = uuidv4();
  conversations.set(id, {
    id,
    messages: [{ role: 'system', content: getSystemPrompt() }],
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
 * Process user message through the LLM orchestrator
 * Handles streaming, tool calls, and WebSocket broadcasting
 */
export async function processUserMessage(params: {
  conversationId: string;
  message: string;
  wsServer?: VoiceAssistantWebSocketServer;
  enableTTS?: boolean;
}): Promise<string> {
  const conversation = conversations.get(params.conversationId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  // Add user message to context
  conversation.messages.push({
    role: 'user',
    content: params.message,
  });
  conversation.lastActivity = new Date();

  // Broadcast user message to WebSocket clients
  if (params.wsServer) {
    params.wsServer.broadcastActivityLog({
      id: uuidv4(),
      timestamp: new Date(),
      type: 'transcript',
      content: params.message,
    });
  }

  let assistantResponse = '';

  try {
    // Stream LLM response with tool execution
    assistantResponse = await streamLLM({
      messages: conversation.messages,
      onChunk: (chunk) => {
        // Broadcast streaming chunks to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcast({
            type: 'assistant_chunk',
            payload: { chunk },
          });
        }
      },
      onToolCall: (toolName, args) => {
        // Broadcast tool call to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: uuidv4(),
            timestamp: new Date(),
            type: 'tool_call',
            content: `Calling ${toolName}`,
            metadata: { toolName, arguments: args },
          });
        }
      },
      onToolResult: (toolName, result) => {
        // Broadcast tool result to WebSocket
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: uuidv4(),
            timestamp: new Date(),
            type: 'tool_result',
            content: `Tool ${toolName} completed`,
            metadata: { toolName, result },
          });
        }
      },
      onFinish: (fullText) => {
        // Broadcast complete assistant response
        if (params.wsServer) {
          params.wsServer.broadcastActivityLog({
            id: uuidv4(),
            timestamp: new Date(),
            type: 'assistant',
            content: fullText,
          });
        }
      },
    });

    // Add assistant response to context
    conversation.messages.push({
      role: 'assistant',
      content: assistantResponse,
    });
  } catch (error: any) {
    // Broadcast error to WebSocket
    if (params.wsServer) {
      params.wsServer.broadcastActivityLog({
        id: uuidv4(),
        timestamp: new Date(),
        type: 'error',
        content: `Error: ${error.message}`,
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
    const ageMinutes = (now.getTime() - conv.lastActivity.getTime()) / (1000 * 60);
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
  conversations: Array<{ id: string; messageCount: number; lastActivity: Date }>;
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
