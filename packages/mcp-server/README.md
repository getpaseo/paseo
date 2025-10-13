# Tmux MCP Server

Model Context Protocol server that enables Claude Desktop to interact with and view tmux session content. This integration allows AI assistants to read from, control, and observe your terminal sessions.

## Features

- List and search tmux sessions
- View and navigate tmux windows and panes
- Capture and expose terminal content from any pane
- Execute commands in tmux panes and retrieve results (use it at your own risk ⚠️)
- Create new tmux sessions and windows
- Split panes horizontally or vertically with customizable sizes
- Kill tmux sessions, windows, and panes

Check out this short video to get excited!

</br>

[![youtube video](http://i.ytimg.com/vi/3W0pqRF1RS0/hqdefault.jpg)](https://www.youtube.com/watch?v=3W0pqRF1RS0)

## Prerequisites

- Node.js
- tmux installed and running

## Usage

### Configure Claude Desktop

Add this MCP server to your Claude Desktop configuration:

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp"]
  }
}
```

### MCP server options

You can optionally specify the command line shell you are using, if unspecified it defaults to `bash`

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp", "--shell-type=fish"]
  }
}
```

The MCP server needs to know the shell only when executing commands, to properly read its exit status.

## Available Resources

- `tmux://sessions` - List all tmux sessions
- `tmux://pane/{paneId}` - View content of a specific tmux pane

## Available Tools

### Hierarchy & Information
- `list` - List tmux sessions, windows, and panes with flexible scoping
  - `scope="all"` - Full nested hierarchy (sessions → windows → panes)
  - `scope="sessions"` - List all sessions
  - `scope="session"` + `target="$0"` - List windows in session
  - `scope="window"` + `target="@1"` - List panes in window
  - `scope="pane"` + `target="%2"` - Get pane details
- `capture-pane` - Capture content from a tmux pane

### Session & Layout Management
- `create-session` - Create a new tmux session
- `create-window` - Create a new window in a tmux session
- `split-pane` - Split a tmux pane horizontally or vertically with optional size
- `kill` - Kill a session, window, or pane by scope and target
  - `scope="session"` + `target="$0"` - Kill session
  - `scope="window"` + `target="@1"` - Kill window
  - `scope="pane"` + `target="%2"` - Kill pane

### Command Execution & Interaction
- `execute-shell-command` - Execute a shell command synchronously (default 30s timeout)
  - Returns output, exit code, and status immediately
  - Use for: ls, grep, npm test, quick commands
  - **For long-running commands:** Use `send-text` with `pressEnter=true` instead, then monitor with `capture-pane`
- `send-keys` - Send special keys or key combinations (raw pass-through)
  - Use for: TUI navigation, control sequences
  - Examples: "Up", "Down", "C-c", "M-x", "Enter", "C-b d"
- `send-text` - Type text character-by-character with literal interpretation
  - Uses `-l` flag per character (prevents special key interpretation)
  - Use for: REPLs, forms, interactive apps, long-running commands
  - Optional `pressEnter` parameter
  - **For long-running commands:** Set `pressEnter=true`, then use `capture-pane` to monitor output

