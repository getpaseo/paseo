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

// Create MCP server
const server = new McpServer(
  {
    name: "tmux-mcp",
    version: "0.3.0",
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

// List tmux hierarchy - Tool
server.tool(
  "list",
  "List tmux sessions, windows, and panes. Use scope='all' for full hierarchy, or drill down with specific scopes. Examples: scope='all' returns nested tree, scope='sessions' returns all sessions, scope='session' with target='$0' returns windows in that session, scope='window' with target='@1' returns panes in that window.",
  {
    scope: z
      .enum(["all", "sessions", "session", "window", "pane"])
      .describe(
        "Scope of listing: 'all' (full tree), 'sessions' (all sessions), 'session' (windows in a session), 'window' (panes in a window), 'pane' (details of a pane)"
      ),
    target: z
      .string()
      .optional()
      .describe(
        "Target ID (required for session/window/pane scopes): session ID (e.g., '$0'), window ID (e.g., '@1'), or pane ID (e.g., '%2')"
      ),
  },
  async ({ scope, target }) => {
    try {
      const result = await tmux.list({ scope, target });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Capture pane content - Tool
server.tool(
  "capture-pane",
  "Capture content from a tmux pane with configurable lines count and optional color preservation. Optionally wait before capturing to allow commands to complete.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    lines: z.string().optional().describe("Number of lines to capture"),
    colors: z
      .boolean()
      .optional()
      .describe(
        "Include color/escape sequences for text and background attributes in output"
      ),
    wait: z
      .number()
      .optional()
      .describe(
        "Milliseconds to wait before capturing output. Useful for long-running commands that need time to complete."
      ),
  },
  async ({ paneId, lines, colors, wait }) => {
    try {
      // Wait if specified
      if (wait) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      // Parse lines parameter if provided
      const linesCount = lines ? parseInt(lines, 10) : undefined;
      const includeColors = colors || false;
      const content = await tmux.capturePaneContent(
        paneId,
        linesCount,
        includeColors
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
            text: `Error capturing pane content: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Create new session - Tool
server.tool(
  "create-session",
  "Create a new tmux session",
  {
    name: z.string().describe("Name for the new tmux session"),
  },
  async ({ name }) => {
    try {
      const session = await tmux.createSession(name);
      return {
        content: [
          {
            type: "text",
            text: session
              ? `Session created: ${JSON.stringify(session, null, 2)}`
              : `Failed to create session: ${name}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating session: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Create new window - Tool
server.tool(
  "create-window",
  "Create a new window in a tmux session. Returns the window ID and the default pane ID. Optionally execute a command in the new window immediately after creation - the command can use any bash operators (&&, ||, |, ;, etc.).",
  {
    sessionId: z.string().describe("ID of the tmux session"),
    name: z.string().describe("Name for the new window"),
    command: z
      .string()
      .optional()
      .describe(
        "Optional shell command to execute in the new window. Supports bash operators: && (chain), || (or), | (pipe), ; (sequential), etc. After sending the command, sleeps 1 second and returns the captured output."
      ),
  },
  async ({ sessionId, name, command }) => {
    try {
      const window = await tmux.createWindow(sessionId, name, command);

      if (!window) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create window: ${name}`,
            },
          ],
        };
      }

      let text = `Window created: ${JSON.stringify(
        {
          id: window.id,
          name: window.name,
          active: window.active,
          sessionId: window.sessionId,
          paneId: window.paneId,
        },
        null,
        2
      )}`;

      if (command && window.output) {
        text += `\n\nCommand executed: ${command}\n\n--- Output ---\n${window.output}`;
      } else if (command) {
        text += `\n\nCommand sent: ${command}`;
      } else {
        text += `\n\nYou can now execute commands directly in pane ${window.paneId}`;
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
            text: `Error creating window: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Rename window - Tool
server.tool(
  "rename-window",
  "Rename a tmux window by its window ID (e.g., @380)",
  {
    windowId: z.string().describe("ID of the tmux window (e.g., '@380')"),
    name: z.string().describe("New name for the window"),
  },
  async ({ windowId, name }) => {
    try {
      await tmux.renameWindow(windowId, name);
      return {
        content: [
          {
            type: "text",
            text: `Window ${windowId} renamed to "${name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming window: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Kill tmux resources - Tool
server.tool(
  "kill",
  "Kill a tmux session, window, or pane. Examples: kill(scope='session', target='$0'), kill(scope='window', target='@1'), kill(scope='pane', target='%2'). No 'all' scope for safety.",
  {
    scope: z
      .enum(["session", "window", "pane"])
      .describe("Type of resource to kill: 'session', 'window', or 'pane'"),
    target: z
      .string()
      .describe(
        "Target ID to kill: session ID (e.g., '$0'), window ID (e.g., '@1'), or pane ID (e.g., '%2')"
      ),
  },
  async ({ scope, target }) => {
    try {
      await tmux.kill({ scope, target });
      return {
        content: [
          {
            type: "text",
            text: `${
              scope.charAt(0).toUpperCase() + scope.slice(1)
            } ${target} has been killed`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error killing ${scope}: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Split pane - Tool
server.tool(
  "split-pane",
  "Split a tmux pane horizontally or vertically",
  {
    paneId: z.string().describe("ID of the tmux pane to split"),
    direction: z
      .enum(["horizontal", "vertical"])
      .optional()
      .describe(
        "Split direction: 'horizontal' (side by side) or 'vertical' (top/bottom). Default is 'vertical'"
      ),
    size: z
      .number()
      .min(1)
      .max(99)
      .optional()
      .describe("Size of the new pane as percentage (1-99). Default is 50%"),
  },
  async ({ paneId, direction, size }) => {
    try {
      const newPane = await tmux.splitPane(
        paneId,
        direction || "vertical",
        size
      );
      return {
        content: [
          {
            type: "text",
            text: newPane
              ? `Pane split successfully. New pane: ${JSON.stringify(
                  newPane,
                  null,
                  2
                )}`
              : `Failed to split pane ${paneId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error splitting pane: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Execute shell command - Tool
server.tool(
  "execute-shell-command",
  "Execute a shell command in a tmux pane synchronously and return results immediately. Waits for command completion (default 30s timeout). Returns output, exit code, and status. Use for quick commands (ls, grep, npm test, etc.). Avoid heredoc syntax (cat << EOF) and multi-line constructs. IMPORTANT: For long-running commands (npm start, servers, watch processes), use send-text with pressEnter=true instead, then monitor output with capture-pane. For interactive apps or special keys, use send-keys.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Shell command to execute"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 30000)"),
  },
  async ({ paneId, command, timeout }) => {
    try {
      const result = await tmux.executeShellCommand({
        paneId,
        command,
        timeout,
      });

      let statusText =
        result.status === "completed" ? "✅ Completed" : "❌ Error";

      return {
        content: [
          {
            type: "text",
            text: `${statusText}\nCommand: ${result.command}\nExit code: ${
              result.exitCode
            }\n\n--- Output ---\n${result.output || "(no output)"}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error executing command: ${error}`,
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
  "Send special keys or key combinations to a tmux pane. Use for TUI navigation and control sequences. Examples: 'Up', 'Down', 'Enter', 'Escape', 'C-c' (Ctrl+C), 'M-x' (Alt+X), 'C-b' (tmux prefix). For typing regular text, use send-text instead. Supports repeating key presses and optionally capturing output after sending keys.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
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
        "Capture pane output after sending keys. Specify 'wait' for slow commands."
      ),
  },
  async ({ paneId, keys, repeat, return_output }) => {
    try {
      const output = await tmux.sendKeys({
        paneId,
        keys,
        repeat,
        return_output,
      });

      if (return_output && output) {
        return {
          content: [
            {
              type: "text",
              text: `Keys '${keys}' sent to pane ${paneId}${
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
            text: `Keys '${keys}' sent to pane ${paneId}${
              repeat && repeat > 1 ? ` (repeated ${repeat} times)` : ""
            }.\n\nUse capture-pane to verify the result.`,
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

// Send text - Tool
server.tool(
  "send-text",
  "Type text into a tmux pane. This is the PRIMARY way to execute shell commands with bash operators (&&, ||, |, ;, etc.) - set pressEnter=true to run the command. Also use for interactive applications, REPLs, forms, and text entry. For special keys or control sequences, use send-keys instead.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    text: z
      .string()
      .describe(
        "Text to type into the pane. For shell commands, can use any bash operators: && (chain), || (or), | (pipe), ; (sequential), etc."
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
        "Capture pane output after sending text. Specify 'wait' for slow commands."
      ),
  },
  async ({ paneId, text, pressEnter, return_output }) => {
    try {
      const output = await tmux.sendText({
        paneId,
        text,
        pressEnter,
        return_output,
      });

      if (return_output && output) {
        return {
          content: [
            {
              type: "text",
              text: `Text sent to pane ${paneId}${
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
            text: `Text sent to pane ${paneId}${
              pressEnter ? " (with Enter)" : ""
            }.\n\nUse capture-pane to verify the result.`,
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

// Expose tmux session list as a resource
server.resource("Tmux Sessions", "tmux://sessions", async () => {
  try {
    const sessions = await tmux.listSessions();
    return {
      contents: [
        {
          uri: "tmux://sessions",
          text: JSON.stringify(
            sessions.map((session) => ({
              id: session.id,
              name: session.name,
              attached: session.attached,
              windows: session.windows,
            })),
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      contents: [
        {
          uri: "tmux://sessions",
          text: `Error listing tmux sessions: ${error}`,
        },
      ],
    };
  }
});

// Expose pane content as a resource
server.resource(
  "Tmux Pane Content",
  new ResourceTemplate("tmux://pane/{paneId}", {
    list: async () => {
      try {
        // Get all sessions
        const sessions = await tmux.listSessions();
        const paneResources = [];

        // For each session, get all windows
        for (const session of sessions) {
          const windows = await tmux.listWindows(session.id);

          // For each window, get all panes
          for (const window of windows) {
            const panes = await tmux.listPanes(window.id);

            // For each pane, create a resource with descriptive name
            for (const pane of panes) {
              paneResources.push({
                name: `Pane: ${session.name} - ${pane.id} - ${pane.title} ${
                  pane.active ? "(active)" : ""
                }`,
                uri: `tmux://pane/${pane.id}`,
                description: `Content from pane ${pane.id} - ${pane.title} in session ${session.name}`,
              });
            }
          }
        }

        return {
          resources: paneResources,
        };
      } catch (error) {
        server.server.sendLoggingMessage({
          level: "error",
          data: `Error listing panes: ${error}`,
        });

        return { resources: [] };
      }
    },
  }),
  async (uri, { paneId }) => {
    try {
      // Ensure paneId is a string
      const paneIdStr = Array.isArray(paneId) ? paneId[0] : paneId;
      // Default to no colors for resources to maintain clean programmatic access
      const content = await tmux.capturePaneContent(paneIdStr, 200, false);
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
            text: `Error capturing pane content: ${error}`,
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

      const port = parseInt(values.port || process.env.PORT || "3000", 10);

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
