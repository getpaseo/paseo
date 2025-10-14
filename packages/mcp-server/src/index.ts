#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tmux from "./tmux.js";
import { startHttpServer } from "./http-server.js";
import os from "node:os";

const DEFAULT_SESSION = "__voice-dev";

// Create MCP server
const server = new McpServer(
  {
    name: "voice-dev-mcp",
    version: "0.4.0",
  },
  {
    capabilities: {
      resources: {
        subscribe: true,
        listChanged: true,
      },
      tools: {
        listChanged: true,
      },
      logging: {},
    },
  }
);

/**
 * Ensure the default session exists
 */
async function ensureDefaultSession(): Promise<void> {
  const session = await tmux.findSessionByName(DEFAULT_SESSION);
  if (!session) {
    console.log(`Creating default session: ${DEFAULT_SESSION}`);
    await tmux.createSession(DEFAULT_SESSION);
  }
}

// List terminals - Tool
server.tool(
  "list-terminals",
  "List all terminals (isolated shell environments). Returns terminal name, active status, current working directory, and currently running command.",
  {},
  async () => {
    try {
      await ensureDefaultSession();

      // Get all windows in the default session
      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      const windows = await tmux.listWindows(session.id);

      // For each window, get the pane and its info
      const terminals = await Promise.all(
        windows.map(async (window) => {
          const panes = await tmux.listPanes(window.id);
          const pane = panes[0]; // Always use first pane
          const workingDirectory = pane
            ? await tmux.getCurrentWorkingDirectory(pane.id)
            : "unknown";
          const currentCommand = pane
            ? await tmux.getCurrentCommand(pane.id)
            : "unknown";

          return {
            name: window.name,
            active: window.active,
            workingDirectory,
            currentCommand,
          };
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(terminals, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing terminals: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Create terminal - Tool
server.tool(
  "create-terminal",
  "Create a new terminal at a specific working directory. Always specify workingDirectory based on context - use project paths when working on projects, or the same directory as current terminal when user says 'another terminal here'. Defaults to ~ only if no context.",
  {
    name: z.string().describe("Name for the new terminal"),
    workingDirectory: z
      .string()
      .default(os.homedir())
      .describe(
        "Working directory for the terminal. Required parameter - set contextually based on what the user is working on. Use project paths when working on projects. Defaults to home directory (~) only if no context."
      ),
    initialCommand: z
      .string()
      .optional()
      .describe(
        "Optional command to execute after creating the terminal. The command runs after changing to the working directory."
      ),
  },
  async ({ name, workingDirectory, initialCommand }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Create window in default session with working directory and optional command
      const window = await tmux.createWindow(session.id, name, {
        workingDirectory,
        command: initialCommand,
      });
      if (!window) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create terminal: ${name}`,
            },
          ],
        };
      }

      const commandOutput = window.output;

      let text = `Terminal created: ${JSON.stringify(
        {
          name: window.name,
          workingDirectory,
        },
        null,
        2
      )}`;

      if (initialCommand && commandOutput) {
        text += `\n\nInitial command executed: ${initialCommand}\n\n--- Output ---\n${commandOutput}`;
      } else if (initialCommand) {
        text += `\n\nInitial command sent: ${initialCommand}`;
      }

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating terminal: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Capture terminal - Tool
server.tool(
  "capture-terminal",
  "Capture the last N lines of output from a terminal. Use this to see command results, check status, or debug issues.",
  {
    terminalName: z.string().describe("Name of the terminal"),
    lines: z
      .number()
      .optional()
      .describe("Number of lines to capture (default: 200)"),
    wait: z
      .number()
      .optional()
      .describe(
        "Milliseconds to wait before capturing output. Useful for slow commands."
      ),
  },
  async ({ terminalName, lines, wait }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Resolve terminal name to window
      const window = await tmux.findWindowByName(session.id, terminalName);
      if (!window) {
        const windows = await tmux.listWindows(session.id);
        const availableNames = windows.map((w) => w.name).join(", ");
        throw new Error(
          `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
        );
      }

      // Wait if specified
      if (wait) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      // Get the pane for this terminal
      const panes = await tmux.listPanes(window.id);
      const pane = panes[0];

      if (!pane) {
        throw new Error(`No pane found for terminal ${terminalName}`);
      }

      const content = await tmux.capturePaneContent(
        pane.id,
        lines || 200,
        false
      );

      return {
        content: [
          {
            type: "text",
            text: content || "No content captured",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error capturing terminal content: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Send text - Tool
server.tool(
  "send-text",
  "Type text into a terminal. This is the PRIMARY way to execute shell commands with bash operators (&&, ||, |, ;, etc.) - set pressEnter=true to run the command. Also use for interactive applications, REPLs, forms, and text entry. For special keys or control sequences, use send-keys instead.",
  {
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
        wait: z
          .number()
          .optional()
          .describe("Milliseconds to wait before capturing output"),
      })
      .optional()
      .describe(
        "Capture terminal output after sending text. Specify 'wait' for slow commands."
      ),
  },
  async ({ terminalName, text, pressEnter, return_output }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Resolve terminal name to window
      const window = await tmux.findWindowByName(session.id, terminalName);
      if (!window) {
        const windows = await tmux.listWindows(session.id);
        const availableNames = windows.map((w) => w.name).join(", ");
        throw new Error(
          `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
        );
      }

      // Get the pane for this terminal
      const panes = await tmux.listPanes(window.id);
      const pane = panes[0];

      if (!pane) {
        throw new Error(`No pane found for terminal ${terminalName}`);
      }

      const output = await tmux.sendText({
        paneId: pane.id,
        text,
        pressEnter,
        return_output,
      });

      if (return_output && output) {
        return {
          content: [
            {
              type: "text",
              text: `Text sent to terminal ${terminalName}${
                pressEnter ? " (with Enter)" : ""
              }.\n\n--- Output ---\n${output}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Text sent to terminal ${terminalName}${
              pressEnter ? " (with Enter)" : ""
            }.\n\nUse capture-terminal to verify the result.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error sending text: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Send keys - Tool
server.tool(
  "send-keys",
  "Send special keys or key combinations to a terminal. Use for TUI navigation and control sequences. Examples: 'Up', 'Down', 'Enter', 'Escape', 'C-c' (Ctrl+C), 'M-x' (Alt+X). For typing regular text, use send-text instead. Supports repeating key presses and optionally capturing output after sending keys.",
  {
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
        wait: z
          .number()
          .optional()
          .describe("Milliseconds to wait before capturing output"),
      })
      .optional()
      .describe(
        "Capture terminal output after sending keys. Specify 'wait' for slow commands."
      ),
  },
  async ({ terminalName, keys, repeat, return_output }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Resolve terminal name to window
      const window = await tmux.findWindowByName(session.id, terminalName);
      if (!window) {
        const windows = await tmux.listWindows(session.id);
        const availableNames = windows.map((w) => w.name).join(", ");
        throw new Error(
          `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
        );
      }

      // Get the pane for this terminal
      const panes = await tmux.listPanes(window.id);
      const pane = panes[0];

      if (!pane) {
        throw new Error(`No pane found for terminal ${terminalName}`);
      }

      const output = await tmux.sendKeys({
        paneId: pane.id,
        keys,
        repeat,
        return_output,
      });

      if (return_output && output) {
        return {
          content: [
            {
              type: "text",
              text: `Keys '${keys}' sent to terminal ${terminalName}${
                repeat && repeat > 1 ? ` (repeated ${repeat} times)` : ""
              }.\n\n--- Output ---\n${output}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Keys '${keys}' sent to terminal ${terminalName}${
              repeat && repeat > 1 ? ` (repeated ${repeat} times)` : ""
            }.\n\nUse capture-terminal to verify the result.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error sending keys: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Rename terminal - Tool
server.tool(
  "rename-terminal",
  "Rename a terminal to a more descriptive name",
  {
    terminalName: z.string().describe("Current name of the terminal"),
    newName: z.string().describe("New name for the terminal"),
  },
  async ({ terminalName, newName }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      await tmux.renameWindow(session.id, terminalName, newName);
      return {
        content: [
          {
            type: "text",
            text: `Terminal "${terminalName}" renamed to "${newName}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming terminal: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Kill terminal - Tool
server.tool(
  "kill-terminal",
  "Close a terminal and end its shell session",
  {
    terminalName: z.string().describe("Name of the terminal"),
  },
  async ({ terminalName }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Resolve terminal name to window
      const window = await tmux.findWindowByName(session.id, terminalName);
      if (!window) {
        const windows = await tmux.listWindows(session.id);
        const availableNames = windows.map((w) => w.name).join(", ");
        throw new Error(
          `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
        );
      }

      await tmux.killWindow(window.id);
      return {
        content: [
          {
            type: "text",
            text: `Terminal "${terminalName}" has been closed`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error killing terminal: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Expose terminals as a resource
server.resource("Terminals", "tmux://terminals", async () => {
  try {
    await ensureDefaultSession();

    const session = await tmux.findSessionByName(DEFAULT_SESSION);
    if (!session) {
      throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
    }

    const windows = await tmux.listWindows(session.id);

    const terminals = await Promise.all(
      windows.map(async (window) => {
        const panes = await tmux.listPanes(window.id);
        const pane = panes[0];
        const workingDirectory = pane
          ? await tmux.getCurrentWorkingDirectory(pane.id)
          : "unknown";
        const currentCommand = pane
          ? await tmux.getCurrentCommand(pane.id)
          : "unknown";

        return {
          name: window.name,
          active: window.active,
          workingDirectory,
          currentCommand,
        };
      })
    );

    return {
      contents: [
        {
          uri: "tmux://terminals",
          text: JSON.stringify(terminals, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      contents: [
        {
          uri: "tmux://terminals",
          text: `Error listing terminals: ${error}`,
        },
      ],
    };
  }
});

// Expose terminal content as a resource
server.resource(
  "Terminal Content",
  new ResourceTemplate("tmux://terminal/{terminalName}", {
    list: async () => {
      try {
        await ensureDefaultSession();

        const session = await tmux.findSessionByName(DEFAULT_SESSION);
        if (!session) {
          return { resources: [] };
        }

        const windows = await tmux.listWindows(session.id);

        const terminalResources = windows.map((window) => ({
          name: `Terminal: ${window.name} ${window.active ? "(active)" : ""}`,
          uri: `tmux://terminal/${encodeURIComponent(window.name)}`,
          description: `Content from terminal ${window.name}`,
        }));

        return {
          resources: terminalResources,
        };
      } catch (error) {
        server.server.sendLoggingMessage({
          level: "error",
          data: `Error listing terminals: ${error}`,
        });

        return { resources: [] };
      }
    },
  }),
  async (uri, { terminalName }) => {
    try {
      await ensureDefaultSession();

      const session = await tmux.findSessionByName(DEFAULT_SESSION);
      if (!session) {
        throw new Error(`Default session not found: ${DEFAULT_SESSION}`);
      }

      // Ensure terminalName is a string
      const terminalNameStr = Array.isArray(terminalName)
        ? terminalName[0]
        : terminalName;

      // Decode URI component in case terminal name has special characters
      const decodedTerminalName = decodeURIComponent(terminalNameStr);

      // Resolve terminal name to window
      const window = await tmux.findWindowByName(session.id, decodedTerminalName);
      if (!window) {
        throw new Error(`Terminal '${decodedTerminalName}' not found`);
      }

      // Get the pane for this terminal
      const panes = await tmux.listPanes(window.id);
      const pane = panes[0];

      if (!pane) {
        throw new Error(`No pane found for terminal ${decodedTerminalName}`);
      }

      const content = await tmux.capturePaneContent(pane.id, 200, false);

      return {
        contents: [
          {
            uri: uri.href,
            text: content || "No content captured",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Error capturing terminal content: ${error}`,
          },
        ],
      };
    }
  }
);

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        "shell-type": { type: "string", default: "bash", short: "s" },
        http: { type: "boolean", default: false },
        port: { type: "string" },
        password: { type: "string" },
      },
      allowPositionals: true,
    });

    // Set shell configuration
    tmux.setShellConfig({
      type: values["shell-type"] as string,
    });

    // Ensure default session exists
    await ensureDefaultSession();

    console.log(values, process.argv);

    // Check if HTTP mode is enabled
    if (values.http) {
      if (!values.password) {
        console.error("Error: --password is required when using --http mode");
        console.error(
          "\nUsage: tmux-mcp --http --password your-secret-password"
        );
        console.error(
          "Set PORT environment variable to change port (default: 3000)"
        );
        process.exit(1);
      }

      const port = Number(values.port || process.env.PORT || "6767");

      // Start HTTP server
      startHttpServer({
        port,
        password: values.password,
        server,
      });
    } else {
      // Start stdio server (default)
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
