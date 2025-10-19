import { stepCountIs, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import {
  listTerminals,
  createTerminal,
  captureTerminal,
  sendText,
  sendKeys,
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
    description:
      "List all terminals (isolated shell environments). Returns terminal name, active status, current working directory, currently running command, and the last 5 lines of output for each terminal.",
    inputSchema: z.object({}),
    execute: async () => {
      const terminals = await listTerminals();
      return { terminals };
    },
  }),

  create_terminal: tool({
    description:
      "Create a new terminal (isolated shell environment) at a specific working directory. Optionally execute an initial command after creation. Terminal names must be unique. Always specify workingDirectory based on context - use project paths when working on projects, or the same directory as current terminal when user says 'another terminal here'. Defaults to ~ only if no context.",
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "Unique name for the terminal. Should be descriptive of what the terminal is used for (e.g., 'web-dev', 'api-server', 'tests')."
        ),
      workingDirectory: z
        .string()
        .describe(
          "Absolute path to the working directory for this terminal. Can use ~ for home directory. Required parameter - set contextually based on what the user is working on. Use project paths when working on projects. Defaults to home directory (~) only if no context."
        ),
      initialCommand: z
        .string()
        .optional()
        .describe(
          "Optional command to execute after creating the terminal (e.g., 'npm run dev', 'python -m venv venv'). The command runs after changing to the working directory."
        ),
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
    description:
      "Capture and return the output from a terminal. Returns the last N lines of terminal content. Useful for checking command results, monitoring running processes, or debugging issues.",
    inputSchema: z.object({
      terminalName: z.string().describe("Name of the terminal"),
      lines: z
        .number()
        .optional()
        .describe("Number of lines to capture (default: 200)"),
      maxWait: z
        .number()
        .optional()
        .describe(
          "Maximum milliseconds to wait for terminal activity to settle before capturing. Polls every 100ms and waits for 1s of no changes. Useful for commands with delayed output."
        ),
    }),
    execute: async ({ terminalName, lines, maxWait }) => {
      const output = await captureTerminal(terminalName, lines, maxWait);
      return { output };
    },
  }),

  send_text: tool({
    description:
      "Type text into a terminal. This is the PRIMARY way to execute shell commands with bash operators (&&, ||, |, ;, etc.) - set pressEnter=true to run the command. Also use for interactive applications, REPLs, forms, and text entry. For special keys or control sequences, use send_keys instead.",
    inputSchema: z.object({
      terminalName: z.string().describe("Name of the terminal"),
      text: z
        .string()
        .describe(
          "Text to type into the terminal. For shell commands, can use any bash operators: && (chain), || (or), | (pipe), ; (sequential), etc."
        ),
      pressEnter: z
        .boolean()
        .optional()
        .describe(
          "Press Enter after typing the text (default: false). Set to true to execute shell commands or submit text input."
        ),
      return_output: z
        .object({
          lines: z
            .number()
            .optional()
            .describe("Number of lines to capture (default: 200)"),
          waitForSettled: z
            .boolean()
            .optional()
            .describe(
              "Wait for terminal activity to settle before returning output. Polls terminal and waits 500ms after last change (default: true)"
            ),
          maxWait: z
            .number()
            .optional()
            .describe(
              "Maximum milliseconds to wait for activity to settle (default: 120000 = 2 minutes)"
            ),
        })
        .optional()
        .describe(
          "Capture terminal output after sending text. By default waits for activity to settle."
        ),
    }),
    execute: async ({ terminalName, text, pressEnter, return_output }) => {
      const output = await sendText(
        terminalName,
        text,
        pressEnter,
        return_output
      );
      return { output };
    },
  }),

  send_keys: tool({
    description:
      "Send special keys or key combinations to a terminal. Use for TUI navigation and control sequences. Examples: 'Up', 'Down', 'Enter', 'Escape', 'C-c' (Ctrl+C), 'M-x' (Alt+X). For typing regular text, use send_text instead. Supports repeating key presses and optionally capturing output after sending keys.",
    inputSchema: z.object({
      terminalName: z.string().describe("Name of the terminal"),
      keys: z
        .string()
        .describe(
          "Special key name or key combination: 'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'Space', 'C-c', 'M-x', etc."
        ),
      repeat: z
        .number()
        .min(1)
        .optional()
        .describe("Number of times to repeat the key press (default: 1)"),
      return_output: z
        .object({
          lines: z
            .number()
            .optional()
            .describe("Number of lines to capture (default: 200)"),
          waitForSettled: z
            .boolean()
            .optional()
            .describe(
              "Wait for terminal activity to settle before returning output. Polls terminal and waits 500ms after last change (default: true)"
            ),
          maxWait: z
            .number()
            .optional()
            .describe(
              "Maximum milliseconds to wait for activity to settle (default: 120000 = 2 minutes)"
            ),
        })
        .optional()
        .describe(
          "Capture terminal output after sending keys. By default waits for activity to settle."
        ),
    }),
    execute: async ({ terminalName, keys, repeat, return_output }) => {
      const output = await sendKeys(terminalName, keys, repeat, return_output);
      return { output };
    },
  }),

  rename_terminal: tool({
    description:
      "Rename a terminal to a more descriptive name. The new name must be unique among all terminals.",
    inputSchema: z.object({
      terminalName: z.string().describe("Current name of the terminal"),
      newName: z
        .string()
        .describe(
          "New unique name for the terminal. Should be descriptive of the terminal's purpose."
        ),
    }),
    execute: async ({ terminalName, newName }) => {
      await renameTerminal(terminalName, newName);
      return { success: true };
    },
  }),

  kill_terminal: tool({
    description:
      "Close and destroy a terminal. This will terminate any running processes in the terminal. Use with caution.",
    inputSchema: z.object({
      terminalName: z
        .string()
        .describe(
          "Name of the terminal to kill. Get this from list_terminals."
        ),
    }),
    execute: async ({ terminalName }) => {
      await killTerminal(terminalName);
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
  systemPrompt: string;
  messages: Message[];
  abortSignal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
  onTextSegment?: (segment: string) => void;
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    args: any
  ) => Promise<void>;
  onToolResult?: (toolCallId: string, toolName: string, result: any) => void;
  onToolError?: (
    toolCallId: string,
    toolName: string,
    error: unknown
  ) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onFinish?: (fullText: string) => void | Promise<void>;
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
    system: params.systemPrompt,
    messages: params.messages,
    tools: terminalTools,
    abortSignal: params.abortSignal,
    onChunk: async ({ chunk }) => {
      // console.log("onChunk", chunk);
      if (chunk.type === "text-delta") {
        // Accumulate text in buffer
        textBuffer += chunk.text;
        fullText += chunk.text;

        params.onChunk?.(chunk.text);
      } else if (chunk.type === "tool-call") {
        // Flush accumulated text as a segment before tool call
        flushTextBuffer();

        // Emit tool call event
        if (params.onToolCall) {
          await params.onToolCall(
            chunk.toolCallId,
            chunk.toolName,
            chunk.input
          );
        }
      } else if (chunk.type === "tool-result") {
        // Emit tool result event
        if (params.onToolResult) {
          params.onToolResult(chunk.toolCallId, chunk.toolName, chunk.output);
        }
      }
    },
    onError: async (error) => {
      // Emit general stream error
      if (params.onError) {
        await params.onError(error);
      }
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

  for await (const part of result.fullStream) {
    // console.log("part", part);

    // Handle tool-error chunks (not available in onChunk callback)
    if (part.type === "tool-error") {
      if (params.onToolError) {
        await params.onToolError(part.toolCallId, part.toolName, part.error);
      }
    }
  }

  // Flush any remaining text at the end
  flushTextBuffer();

  if (params.onFinish) {
    await params.onFinish(fullText);
  }

  return fullText;
}
