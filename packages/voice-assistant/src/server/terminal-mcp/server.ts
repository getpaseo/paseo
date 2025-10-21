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

  // COMMAND-BASED TOOLS

  // Tool: execute_command
  server.registerTool(
    "execute_command",
    {
      title: "Execute Command",
      description:
        "Execute a shell command in a specified directory. Commands are wrapped in bash -c, so you can use pipes, operators, redirects, and all bash features. The command runs until completion or until output stabilizes (for interactive processes). Returns command ID for follow-up interactions, output, exit code (if finished), and whether the process is still running. Windows remain after command exits for inspection.",
      inputSchema: {
        command: z
          .string()
          .describe(
            "The command to execute. Can include pipes (|), operators (&&, ||, ;), redirects (>, >>), and any bash syntax. Examples: 'npm test', 'ls | grep foo', 'cd src && npm run build'"
          ),
        directory: z
          .string()
          .describe(
            "Absolute path to the working directory. Can use ~ for home directory."
          ),
        maxWait: z
          .number()
          .optional()
          .describe(
            "Maximum milliseconds to wait for command completion or output stability (default: 120000 = 2 minutes). For interactive commands, returns when output stabilizes. For one-shot commands, returns when command exits."
          ),
      },
      outputSchema: {
        commandId: z.string(),
        output: z.string(),
        exitCode: z.number().nullable(),
        isDead: z.boolean(),
      },
    },
    async ({ command, directory, maxWait }) => {
      const result = await terminalManager.executeCommand(
        command,
        directory,
        maxWait
      );
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: list_commands
  server.registerTool(
    "list_commands",
    {
      title: "List Commands",
      description:
        "List all commands (both running and exited). Shows command ID, working directory, current process, whether it has exited (isDead), exit code (if exited), and last few lines of output. Includes dead commands that remain for inspection until explicitly killed.",
      inputSchema: {},
      outputSchema: {
        commands: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            workingDirectory: z.string(),
            currentCommand: z.string(),
            isDead: z.boolean(),
            exitCode: z.number().nullable(),
            lastLines: z.string().nullable(),
          })
        ),
      },
    },
    async () => {
      const commands = await terminalManager.listCommands();
      const output = { commands };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  // Tool: capture_command
  server.registerTool(
    "capture_command",
    {
      title: "Capture Command Output",
      description:
        "Capture output from a command by its ID. Works for both running and exited commands. Returns output, exit code (if exited), and whether the command has finished.",
      inputSchema: {
        commandId: z
          .string()
          .describe(
            "Command ID (window ID like @123) returned from execute_command or list_commands"
          ),
        lines: z
          .number()
          .optional()
          .describe("Number of lines to capture (default: 200)"),
      },
      outputSchema: {
        output: z.string(),
        exitCode: z.number().nullable(),
        isDead: z.boolean(),
      },
    },
    async ({ commandId, lines }) => {
      const result = await terminalManager.captureCommand(commandId, lines);
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: send_text_to_command
  server.registerTool(
    "send_text_to_command",
    {
      title: "Send Text to Command",
      description:
        "Send text input to a running command (by ID). Use this for interactive processes like REPLs, prompts, or text-based interfaces. Only works if the command is still running (isDead=false).",
      inputSchema: {
        commandId: z
          .string()
          .describe(
            "Command ID (window ID like @123) from execute_command or list_commands"
          ),
        text: z.string().describe("Text to send to the command"),
        pressEnter: z
          .boolean()
          .optional()
          .describe("Press Enter after typing text (default: false)"),
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
                "Wait for output to stabilize before returning (default: true)"
              ),
            maxWait: z
              .number()
              .optional()
              .describe(
                "Maximum milliseconds to wait for stability (default: 120000)"
              ),
          })
          .optional()
          .describe("Capture output after sending text"),
      },
      outputSchema: {
        output: z.string().nullable(),
      },
    },
    async ({ commandId, text, pressEnter, return_output }) => {
      const output = await terminalManager.sendTextToCommand(
        commandId,
        text,
        pressEnter,
        return_output
      );
      const result = { output: output || null };
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: send_keys_to_command
  server.registerTool(
    "send_keys_to_command",
    {
      title: "Send Keys to Command",
      description:
        "Send special keys or key combinations to a running command. Use for control sequences and navigation. Examples: 'C-c' (Ctrl+C), 'Enter', 'Escape', 'BTab' (Shift+Tab). Only works if command is still running.",
      inputSchema: {
        commandId: z
          .string()
          .describe("Command ID (window ID like @123)"),
        keys: z
          .string()
          .describe(
            "Special key or combination: 'C-c', 'Enter', 'Escape', 'BTab', etc."
          ),
        repeat: z
          .number()
          .optional()
          .describe("Number of times to repeat the key press (default: 1)"),
        return_output: z
          .object({
            lines: z.number().optional(),
            waitForSettled: z.boolean().optional(),
            maxWait: z.number().optional(),
          })
          .optional()
          .describe("Capture output after sending keys"),
      },
      outputSchema: {
        output: z.string().nullable(),
      },
    },
    async ({ commandId, keys, repeat, return_output }) => {
      const output = await terminalManager.sendKeysToCommand(
        commandId,
        keys,
        repeat,
        return_output
      );
      const result = { output: output || null };
      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: kill_command
  server.registerTool(
    "kill_command",
    {
      title: "Kill Command",
      description:
        "Kill one or more commands and close their windows. Use this to terminate running processes or clean up finished commands. This removes the commands from list_commands.",
      inputSchema: {
        commandIds: z
          .array(z.string())
          .min(1)
          .describe(
            "Array of command IDs (window IDs like @123) from execute_command or list_commands. Can be a single ID or multiple IDs."
          ),
      },
      outputSchema: {
        success: z.boolean(),
        killedCount: z.number(),
      },
    },
    async ({ commandIds }) => {
      let killedCount = 0;
      for (const commandId of commandIds) {
        await terminalManager.killCommand(commandId);
        killedCount++;
      }
      const output = { success: true, killedCount };
      return {
        content: [],
        structuredContent: output,
      };
    }
  );

  return server;
}
