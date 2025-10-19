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
  onTextSegment?: (segment: string) => void;
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
    onChunk: (chuk) => {
      // if (params.onChunk) {
      //   params.onChunk(chunk);
      // }
    },
    stopWhen: stepCountIs(10),
  });

  let fullText = "";
  let textBuffer = "";

  function flushTextBuffer() {
    if (textBuffer.length > 0 && params.onTextSegment) {
      params.onTextSegment(textBuffer);
    }
    textBuffer = "";
  }

  // Stream all events from fullStream
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      // Accumulate text in buffer
      textBuffer += part.text;
      fullText += part.text;

      // Stream individual deltas to caller
      if (params.onChunk) {
        params.onChunk(part.text);
      }
    } else if (part.type === "tool-call") {
      // Flush accumulated text as a segment before tool call
      flushTextBuffer();

      // Emit tool call event
      if (params.onToolCall) {
        params.onToolCall(part.toolName, part.input);
      }
    } else if (part.type === "tool-result") {
      // Emit tool result event
      if (params.onToolResult) {
        params.onToolResult(part.toolName, part.output);
      }
    }
  }

  // Flush any remaining text at the end
  flushTextBuffer();

  if (params.onFinish) {
    params.onFinish(fullText);
  }

  return fullText;
}
