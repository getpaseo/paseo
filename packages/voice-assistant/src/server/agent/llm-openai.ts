import { stepCountIs, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import {
  listTerminals,
  createTerminal,
  captureTerminal,
  sendText,
  renameTerminal,
  killTerminal,
} from "../daemon/terminal-manager.js";
import invariant from "tiny-invariant";

/**
 * Terminal tools using Vercel AI SDK tool() function
 * These are automatically executed when the LLM calls them
 */
export const terminalTools = {
  list_terminals: tool({
    description: "List all available terminals in the voice-dev session",
    inputSchema: z.object({}),
    execute: async () => {
      const terminals = await listTerminals();
      return { terminals };
    },
  }),

  create_terminal: tool({
    description:
      "Create a new terminal with specified name and working directory",
    inputSchema: z.object({
      name: z.string().describe("Unique name for the terminal"),
      workingDirectory: z.string().describe("Working directory path"),
      initialCommand: z
        .string()
        .optional()
        .describe("Optional command to run on creation"),
    }),
    execute: async ({ name, workingDirectory, initialCommand }) => {
      const terminal = await createTerminal({
        name,
        workingDirectory,
        initialCommand,
      });
      return { terminal };
    },
  }),

  capture_terminal: tool({
    description: "Capture and return the output from a terminal",
    inputSchema: z.object({
      terminalId: z.string().describe("Terminal ID (e.g., @123)"),
      lines: z
        .number()
        .optional()
        .describe("Number of lines to capture (default: 200)"),
      wait: z
        .number()
        .optional()
        .describe("Milliseconds to wait before capture"),
    }),
    execute: async ({ terminalId, lines, wait }) => {
      const output = await captureTerminal(terminalId, lines, wait);
      return { output };
    },
  }),

  send_text: tool({
    description: "Send text or commands to a terminal",
    inputSchema: z.object({
      terminalId: z.string().describe("Terminal ID (e.g., @123)"),
      text: z.string().describe("Text to send to the terminal"),
      pressEnter: z
        .boolean()
        .optional()
        .describe("Whether to press Enter after text"),
      return_output: z
        .object({
          lines: z.number().optional(),
          wait: z.number().optional(),
        })
        .optional()
        .describe("Capture output after sending"),
    }),
    execute: async ({ terminalId, text, pressEnter, return_output }) => {
      const output = await sendText(
        terminalId,
        text,
        pressEnter,
        return_output
      );
      return { output };
    },
  }),

  rename_terminal: tool({
    description: "Rename an existing terminal",
    inputSchema: z.object({
      terminalId: z.string().describe("Terminal ID to rename"),
      newName: z.string().describe("New unique name for the terminal"),
    }),
    execute: async ({ terminalId, newName }) => {
      await renameTerminal(terminalId, newName);
      return { success: true };
    },
  }),

  kill_terminal: tool({
    description: "Close and destroy a terminal",
    inputSchema: z.object({
      terminalId: z.string().describe("Terminal ID to kill"),
    }),
    execute: async ({ terminalId }) => {
      await killTerminal(terminalId);
      return { success: true };
    },
  }),
};

/**
 * Message interface for conversation
 */
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streaming LLM parameters
 */
export interface StreamLLMParams {
  messages: Message[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolName: string, args: any) => void;
  onToolResult?: (toolName: string, result: any) => void;
  onFinish?: (fullText: string) => void;
}

/**
 * Stream LLM response with automatic tool execution
 */
export async function streamLLM(params: StreamLLMParams): Promise<string> {
  invariant(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is required");

  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const result = await streamText({
    model: openrouter("anthropic/claude-haiku-4.5"),
    messages: params.messages,
    tools: terminalTools,
    stopWhen: stepCountIs(10),
    onStepFinish: async (event) => {
      // Called after each step (tool call or text generation)
      if (event.toolCalls && event.toolCalls.length > 0) {
        for (const toolCall of event.toolCalls) {
          if (params.onToolCall) {
            params.onToolCall(toolCall.toolName, toolCall.input);
          }
        }
      }

      if (event.toolResults && event.toolResults.length > 0) {
        for (const toolResult of event.toolResults) {
          if (params.onToolResult) {
            params.onToolResult(toolResult.toolName, toolResult.output);
          }
        }
      }
    },
  });

  let fullText = "";

  result.fullStream;

  // Stream text chunks to the caller
  for await (const chunk of result.textStream) {
    fullText += chunk;
    if (params.onChunk) {
      params.onChunk(chunk);
    }
  }

  if (params.onFinish) {
    params.onFinish(fullText);
  }

  return fullText;
}
