/**
 * OpenAI function calling schemas for terminal operations
 * These tools are exposed to the LLM for terminal control
 */

export const terminalTools = [
  {
    type: "function",
    function: {
      name: "list_terminals",
      description:
        "List all available terminals in the voice-dev session. Returns terminal ID, name, working directory, and current command for each terminal.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_terminal",
      description:
        "Create a new terminal (tmux window) with a specific name and working directory. Optionally execute an initial command after creation. Terminal names must be unique.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Unique name for the terminal. Should be descriptive of what the terminal is used for (e.g., 'web-dev', 'api-server', 'tests').",
          },
          workingDirectory: {
            type: "string",
            description:
              "Absolute path to the working directory for this terminal. Can use ~ for home directory.",
          },
          initialCommand: {
            type: "string",
            description:
              "Optional command to execute after creating the terminal (e.g., 'npm run dev', 'python -m venv venv').",
          },
        },
        required: ["name", "workingDirectory"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "capture_terminal",
      description:
        "Capture and return the output from a terminal. Returns the last N lines of terminal content. Useful for checking command results or monitoring running processes.",
      parameters: {
        type: "object",
        properties: {
          terminalId: {
            type: "string",
            description:
              "The terminal ID (window ID format: @123) to capture output from. Get this from list_terminals.",
          },
          lines: {
            type: "number",
            description:
              "Number of lines to capture from the terminal history. Defaults to 200.",
          },
          wait: {
            type: "number",
            description:
              "Optional milliseconds to wait before capturing output. Useful when you just sent a command and want to wait for it to complete.",
          },
        },
        required: ["terminalId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_text",
      description:
        "Type text into a terminal. Can optionally press Enter to execute the text as a command. Can optionally return the output after execution. This is the primary way to run commands in terminals.",
      parameters: {
        type: "object",
        properties: {
          terminalId: {
            type: "string",
            description:
              "The terminal ID (window ID format: @123) to send text to. Get this from list_terminals.",
          },
          text: {
            type: "string",
            description:
              "The text to type into the terminal. Can be a command, input for a running program, or any text.",
          },
          pressEnter: {
            type: "boolean",
            description:
              "Whether to press Enter after typing the text. Set to true to execute commands. Defaults to false.",
          },
          return_output: {
            type: "object",
            description:
              "Optional. If provided, will wait and return the terminal output after sending the text.",
            properties: {
              lines: {
                type: "number",
                description: "Number of lines to capture. Defaults to 200.",
              },
              wait: {
                type: "number",
                description:
                  "Milliseconds to wait before capturing output. Defaults to 500ms.",
              },
            },
          },
        },
        required: ["terminalId", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_terminal",
      description:
        "Rename an existing terminal. The new name must be unique among all terminals.",
      parameters: {
        type: "object",
        properties: {
          terminalId: {
            type: "string",
            description:
              "The terminal ID (window ID format: @123) to rename. Get this from list_terminals.",
          },
          newName: {
            type: "string",
            description:
              "The new unique name for the terminal. Should be descriptive of the terminal's purpose.",
          },
        },
        required: ["terminalId", "newName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_terminal",
      description:
        "Close and destroy a terminal. This will terminate any running processes in the terminal. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          terminalId: {
            type: "string",
            description:
              "The terminal ID (window ID format: @123) to kill. Get this from list_terminals.",
          },
        },
        required: ["terminalId"],
      },
    },
  },
] as const;
