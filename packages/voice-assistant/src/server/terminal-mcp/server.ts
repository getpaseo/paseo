import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TerminalManager } from "./terminal-manager.js";

export interface TerminalMcpServerOptions {
  sessionName: string;
}

/**
 * Create and configure the Terminal MCP Server
 * Multiple instances can run independently with different session names
 */
export async function createTerminalMcpServer(
  options: TerminalMcpServerOptions
): Promise<McpServer> {
  const { sessionName } = options;
  const terminalManager = new TerminalManager(sessionName);

  // Initialize the session
  await terminalManager.initialize();

  const server = new McpServer({
    name: "terminal-mcp",
    version: "1.0.0",
  });

  // Tool: list_terminals
  server.registerTool(
    "list_terminals",
    {
      title: "List Terminals",
      description:
        "List all terminals (isolated shell environments). Returns terminal name, active status, current working directory, currently running command, and the last 5 lines of output for each terminal.",
      inputSchema: {},
      outputSchema: {
        terminals: z.array(
          z.object({
            name: z.string(),
            workingDirectory: z.string(),
            currentCommand: z.string(),
            lastLines: z.string().optional(),
          })
        ),
      },
    },
    async () => {
      const terminals = await terminalManager.listTerminals();
      const output = { terminals };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  // Tool: create_terminal
  server.registerTool(
    "create_terminal",
    {
      title: "Create Terminal",
      description:
        "Create a new terminal (isolated shell environment) at a specific working directory. Optionally execute an initial command after creation. Terminal names must be unique. Always specify workingDirectory based on context - use project paths when working on projects, or the same directory as current terminal when user says 'another terminal here'. Defaults to ~ only if no context.",
      inputSchema: {
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
      },
      outputSchema: {
        terminal: z.object({
          name: z.string(),
          workingDirectory: z.string(),
          currentCommand: z.string(),
          commandOutput: z.string().optional(),
        }),
      },
    },
    async ({ name, workingDirectory, initialCommand }) => {
      const terminal = await terminalManager.createTerminal({
        name,
        workingDirectory,
        initialCommand,
      });
      const output = { terminal };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  // Tool: capture_terminal
  server.registerTool(
    "capture_terminal",
    {
      title: "Capture Terminal",
      description:
        "Capture and return the output from a terminal. Returns the last N lines of terminal content. Useful for checking command results, monitoring running processes, or debugging issues.",
      inputSchema: {
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
      },
      outputSchema: {
        output: z.string(),
      },
    },
    async ({ terminalName, lines, maxWait }) => {
      const output = await terminalManager.captureTerminal(
        terminalName,
        lines,
        maxWait
      );
      const result = { output };
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: send_text
  server.registerTool(
    "send_text",
    {
      title: "Send Text",
      description:
        "Type text into a terminal. This is the PRIMARY way to execute shell commands with bash operators (&&, ||, |, ;, etc.) - set pressEnter=true to run the command. Also use for interactive applications, REPLs, forms, and text entry. For special keys or control sequences, use send_keys instead.",
      inputSchema: {
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
      },
      outputSchema: {
        output: z.string().optional(),
      },
    },
    async ({ terminalName, text, pressEnter, return_output }) => {
      const output = await terminalManager.sendText(
        terminalName,
        text,
        pressEnter,
        return_output
      );
      const result = { output: output || undefined };
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: send_keys
  server.registerTool(
    "send_keys",
    {
      title: "Send Keys",
      description:
        "Send special keys or key combinations to a terminal. Use for TUI navigation and control sequences. Examples: 'Up', 'Down', 'Enter', 'Escape', 'C-c' (Ctrl+C), 'M-x' (Alt+X). For typing regular text, use send_text instead. Supports repeating key presses and optionally capturing output after sending keys.",
      inputSchema: {
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
      },
      outputSchema: {
        output: z.string().optional(),
      },
    },
    async ({ terminalName, keys, repeat, return_output }) => {
      const output = await terminalManager.sendKeys(
        terminalName,
        keys,
        repeat,
        return_output
      );
      const result = { output: output || undefined };
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: rename_terminal
  server.registerTool(
    "rename_terminal",
    {
      title: "Rename Terminal",
      description:
        "Rename a terminal to a more descriptive name. The new name must be unique among all terminals.",
      inputSchema: {
        terminalName: z.string().describe("Current name of the terminal"),
        newName: z
          .string()
          .describe(
            "New unique name for the terminal. Should be descriptive of the terminal's purpose."
          ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalName, newName }) => {
      await terminalManager.renameTerminal(terminalName, newName);
      const output = { success: true };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  // Tool: kill_terminal
  server.registerTool(
    "kill_terminal",
    {
      title: "Kill Terminal",
      description:
        "Close and destroy a terminal. This will terminate any running processes in the terminal. Use with caution.",
      inputSchema: {
        terminalName: z
          .string()
          .describe(
            "Name of the terminal to kill. Get this from list_terminals."
          ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalName }) => {
      await terminalManager.killTerminal(terminalName);
      const output = { success: true };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  return server;
}
