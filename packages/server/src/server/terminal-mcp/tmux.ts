import {
  exec as execCallback,
  execFile as execFileCallback,
} from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import os from "node:os";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: "pending" | "completed" | "error";
  startTime: Date;
  result?: string;
  exitCode?: number;
  rawMode?: boolean;
}

export type ShellType = "bash" | "zsh" | "fish";

let shellConfig: { type: ShellType } = { type: "bash" };

const ANSI_ESCAPE_REGEX =
  /\u001B[\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsiSequences(value: string): string {
  if (!value) {
    return "";
  }
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

export function setShellConfig(config: { type: string }): void {
  // Validate shell type
  const validShells: ShellType[] = ["bash", "zsh", "fish"];

  if (validShells.includes(config.type as ShellType)) {
    shellConfig = { type: config.type as ShellType };
  } else {
    shellConfig = { type: "bash" };
  }
}

/**
 * Execute a tmux command and return the result
 * Uses execFile to avoid shell interpretation of special characters
 */
export async function executeTmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("tmux", args);
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux(["list-sessions", "-F", "#{session_name}"]);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format =
    "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
  const output = await executeTmux(["list-sessions", "-F", format]);

  if (!output) return [];

  return output.split("\n").map((line) => {
    const [id, name, attached, windows] = line.split(":");
    return {
      id,
      name,
      attached: attached === "1",
      windows: parseInt(windows, 10),
    };
  });
}

/**
 * Find a session by name
 */
export async function findSessionByName(
  name: string
): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find((session) => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * Find a window by name in a session
 */
export async function findWindowByName(
  sessionId: string,
  name: string
): Promise<TmuxWindow | null> {
  try {
    const windows = await listWindows(sessionId);
    return windows.find((window) => window.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if a window name is unique in a session
 */
export async function isWindowNameUnique(
  sessionId: string,
  name: string
): Promise<boolean> {
  const window = await findWindowByName(sessionId, name);
  return window === null;
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
  const output = await executeTmux([
    "list-windows",
    "-t",
    sessionId,
    "-F",
    format,
  ]);

  if (!output) return [];

  return output.split("\n").map((line) => {
    const [id, name, active] = line.split(":");
    return {
      id,
      name,
      active: active === "1",
      sessionId,
    };
  });
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
  const output = await executeTmux([
    "list-panes",
    "-t",
    windowId,
    "-F",
    format,
  ]);

  if (!output) return [];

  return output.split("\n").map((line) => {
    const [id, title, active] = line.split(":");
    return {
      id,
      windowId,
      title: title,
      active: active === "1",
    };
  });
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(
  paneId: string,
  lines: number = 200,
  includeColors: boolean = false
): Promise<string> {
  // Capture a large range to ensure we have enough content
  const captureLines = Math.max(lines, 1000);
  const args = ["capture-pane", "-p"];
  if (includeColors) {
    args.push("-e");
  }
  args.push("-t", paneId, "-S", `-${captureLines}`, "-E", "-");
  const output = await executeTmux(args);

  // Trim trailing whitespace, split by lines, take last N lines, rejoin
  const trimmed = output.trimEnd();
  const allLines = trimmed.split("\n");
  const lastLines = allLines.slice(-lines);
  const joined = lastLines.join("\n");

  return includeColors ? joined : stripAnsiSequences(joined);
}

/**
 * Get the current working directory of a pane
 */
export async function getCurrentWorkingDirectory(
  paneId: string
): Promise<string> {
  try {
    const tmuxPath = await executeTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_current_path}",
    ]);

    // If tmux returns a valid path, use it
    if (tmuxPath && tmuxPath.trim()) {
      return tmuxPath;
    }

    // Fallback: get the PID and use lsof to find the actual CWD
    const shellPid = await executeTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_pid}",
    ]);
    const { stdout } = await exec(
      `lsof -a -p ${shellPid.trim()} -d cwd -Fn | grep '^n' | cut -c2-`
    );
    return stdout.trim() || tmuxPath;
  } catch (error) {
    // If all else fails, return empty string
    return "";
  }
}

/**
 * Get stored working directory from window user option (for dead panes)
 * Falls back to current working directory if not stored
 */
export async function getStoredWorkingDirectory(windowId: string, paneId: string): Promise<string> {
  try {
    const stored = await executeTmux([
      "show-window-options",
      "-t",
      windowId,
      "-v",
      "@working_directory",
    ]);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch (error) {
    // Option not set, fall back to current
  }
  return getCurrentWorkingDirectory(paneId);
}

/**
 * Get the current command running in a pane (full command line with arguments)
 * Gets the immediate child process of the shell, not the shell itself
 */
export async function getCurrentCommand(paneId: string): Promise<string> {
  try {
    // Get the shell PID (the pane's main process)
    const shellPid = await executeTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_pid}",
    ]);

    // First, check if there's a child process using comm= (works for all programs including top)
    // Use 'ax' flags to see all processes
    const { stdout: childPid } = await exec(
      `ps ax -o pid=,ppid=,comm= | awk '$2 == ${shellPid.trim()} { print $1; exit }'`
    );

    if (childPid.trim()) {
      // Found a child process, get its full command with args
      const { stdout: fullCmd } = await exec(
        `ps -p ${childPid.trim()} -o args= | sed 's/\\\\012.*//'`
      );
      const command = fullCmd.trim();
      if (command) {
        return command;
      }
    }

    // No child process, just return the shell name
    const { stdout: shellCmd } = await exec(`ps -p ${shellPid} -o comm=`);
    return shellCmd.trim();
  } catch (error) {
    // Fallback to just the command name if ps fails
    return executeTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_current_command}",
    ]);
  }
}

/**
 * Get stored command from window user option (for dead panes)
 * Falls back to current command if not stored
 */
export async function getStoredCommand(windowId: string, paneId: string): Promise<string> {
  try {
    const stored = await executeTmux([
      "show-window-options",
      "-t",
      windowId,
      "-v",
      "@command",
    ]);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch (error) {
    // Option not set, fall back to current
  }
  return getCurrentCommand(paneId);
}

/**
 * Create a new tmux session with a default window named "default" in home directory
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  const homeDir = process.env.HOME || "~";
  await executeTmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-n",
    "default",
    "-c",
    homeDir,
  ]);

  // Disable automatic window renaming for all windows in the session
  await executeTmux([
    "set-window-option",
    "-t",
    name,
    "automatic-rename",
    "off",
  ]);

  return findSessionByName(name);
}

/**
 * Expand tilde in path to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const homeDir = process.env.HOME || os.homedir();
    return path.replace("~", homeDir);
  }
  if (path === "~") {
    return process.env.HOME || os.homedir();
  }
  return path;
}

/**
 * Create a new window in a session with optional working directory and initial command
 */
export async function createWindow(
  sessionId: string,
  name: string,
  options?: {
    workingDirectory?: string;
    command?: string | null;
  }
): Promise<(TmuxWindow & { paneId: string; output?: string | null }) | null> {
  // Validate name uniqueness
  const isUnique = await isWindowNameUnique(sessionId, name);
  if (!isUnique) {
    throw new Error(
      `Terminal with name '${name}' already exists. Please choose a unique name.`
    );
  }

  // Build new-window command with optional working directory
  const args = ["new-window", "-t", sessionId, "-n", name];
  if (options?.workingDirectory) {
    // Expand tilde to home directory before passing to tmux
    const expandedPath = expandTilde(options.workingDirectory);
    args.push("-c", expandedPath);
  }

  await executeTmux(args);
  const windows = await listWindows(sessionId);
  const window = windows.find((window) => window.name === name);

  if (!window) return null;

  // Disable automatic window renaming
  await executeTmux([
    "set-window-option",
    "-t",
    window.id,
    "automatic-rename",
    "off",
  ]);

  // Get the default pane created with the window
  const panes = await listPanes(window.id);
  const defaultPane = panes[0];

  let commandOutput: string | null = null;

  // If command is provided, execute it in the new pane
  if (options?.command && defaultPane) {
    commandOutput = (await sendText({
      paneId: defaultPane.id,
      text: options.command,
      pressEnter: true,
      return_output: {
        waitForSettled: true,
        maxWait: 120000,
      },
    })) as string;
  }

  return {
    ...window,
    paneId: defaultPane?.id || "",
    output: commandOutput,
  };
}

/**
 * Execute a command in a new window with remain-on-exit enabled
 * This allows capturing output and exit code even after the command finishes
 *
 * @param sessionId - The tmux session ID
 * @param command - The command to execute (will be wrapped in bash -c)
 * @param workingDirectory - Directory to execute command in
 * @param maxWait - Maximum milliseconds to wait for command completion or stability
 * @returns Window ID, output, exit code (if finished), and whether process is still running
 */
export async function executeCommand({
  sessionId,
  command,
  workingDirectory,
  maxWait = 120000,
}: {
  sessionId: string;
  command: string;
  workingDirectory: string;
  maxWait?: number;
}): Promise<{
  windowId: string;
  paneId: string;
  output: string;
  exitCode: number | null;
  isDead: boolean;
}> {
  // Generate unique window name using timestamp
  const windowName = `cmd-${Date.now()}`;
  const expandedPath = expandTilde(workingDirectory);

  // Create window
  const args = ["new-window", "-t", sessionId, "-n", windowName, "-c", expandedPath];
  await executeTmux(args);

  const windows = await listWindows(sessionId);
  const window = windows.find((w) => w.name === windowName);
  if (!window) {
    throw new Error("Failed to create window for command execution");
  }

  // Enable remain-on-exit to keep window after command finishes
  await executeTmux([
    "set-window-option",
    "-t",
    window.id,
    "remain-on-exit",
    "on",
  ]);

  // Disable automatic window renaming
  await executeTmux([
    "set-window-option",
    "-t",
    window.id,
    "automatic-rename",
    "off",
  ]);

  // Store command and working directory as window options for later retrieval
  await executeTmux([
    "set-window-option",
    "-t",
    window.id,
    "@command",
    command,
  ]);
  await executeTmux([
    "set-window-option",
    "-t",
    window.id,
    "@working_directory",
    expandedPath,
  ]);

  // Get the pane
  const panes = await listPanes(window.id);
  const pane = panes[0];
  if (!pane) {
    throw new Error("No pane found in created window");
  }

  // Execute command via respawn-pane with bash -c wrapper
  // This ensures all bash features work (pipes, operators, etc.)
  const wrappedCommand = `bash -c 'cd "${expandedPath}" && ${command.replace(/'/g, "'\\''")} 2>&1; exit $?'`;
  await executeTmux(["respawn-pane", "-t", pane.id, "-k", wrappedCommand]);

  // Wait for command to finish or reach stability
  const startTime = Date.now();
  let output = "";
  let isDead = false;
  let exitCode: number | null = null;

  while (Date.now() - startTime < maxWait) {
    // Check if pane is dead (command exited)
    const deadStatus = await executeTmux([
      "display-message",
      "-p",
      "-t",
      pane.id,
      "#{pane_dead}",
    ]);
    isDead = deadStatus === "1";

    if (isDead) {
      // Command finished - capture output and exit code
      output = await capturePaneContent(pane.id, 1000, false);
      const exitCodeStr = await executeTmux([
        "display-message",
        "-p",
        "-t",
        pane.id,
        "#{pane_dead_status}",
      ]);
      exitCode = parseInt(exitCodeStr, 10);
      break;
    }

    // Check for stability (output hasn't changed)
    const currentOutput = await capturePaneContent(pane.id, 1000, false);
    if (currentOutput === output) {
      // Wait a bit more to confirm stability
      await new Promise((resolve) => setTimeout(resolve, 500));
      const confirmedOutput = await capturePaneContent(pane.id, 1000, false);
      if (confirmedOutput === currentOutput) {
        // Stable - command is likely waiting for input or running steadily
        output = confirmedOutput;
        break;
      }
    }
    output = currentOutput;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Final capture if we hit timeout
  if (!isDead && !output) {
    output = await capturePaneContent(pane.id, 1000, false);
  }

  return {
    windowId: window.id,
    paneId: pane.id,
    output,
    exitCode,
    isDead,
  };
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(["kill-session", "-t", sessionId]);
}

/**
 * Kill a tmux window by ID
 */
export async function killWindow(windowId: string): Promise<void> {
  await executeTmux(["kill-window", "-t", windowId]);
}

/**
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(["kill-pane", "-t", paneId]);
}

/**
 * Rename a tmux window by name or ID
 */
export async function renameWindow(
  sessionId: string,
  windowNameOrId: string,
  newName: string
): Promise<void> {
  // Validate new name is unique
  const isUnique = await isWindowNameUnique(sessionId, newName);
  if (!isUnique) {
    throw new Error(
      `Terminal with name '${newName}' already exists. Please choose a unique name.`
    );
  }

  // Check if windowNameOrId is a window ID (starts with @) or a name
  let windowId: string;
  if (windowNameOrId.startsWith("@")) {
    windowId = windowNameOrId;
  } else {
    // Resolve name to ID
    const window = await findWindowByName(sessionId, windowNameOrId);
    if (!window) {
      throw new Error(`Terminal '${windowNameOrId}' not found.`);
    }
    windowId = window.id;
  }

  await executeTmux(["rename-window", "-t", windowId, newName]);
  // Disable automatic renaming to preserve the manual name
  await executeTmux([
    "set-window-option",
    "-t",
    windowId,
    "automatic-rename",
    "off",
  ]);
}

/**
 * Split a tmux pane horizontally or vertically
 */
export async function splitPane(
  targetPaneId: string,
  direction: "horizontal" | "vertical" = "vertical",
  size?: number
): Promise<TmuxPane | null> {
  // Build the split-window command args
  const args = ["split-window"];

  // Add direction flag (-h for horizontal, -v for vertical)
  if (direction === "horizontal") {
    args.push("-h");
  } else {
    args.push("-v");
  }

  // Add target pane
  args.push("-t", targetPaneId);

  // Add size if specified (as percentage)
  if (size !== undefined && size > 0 && size < 100) {
    args.push("-p", size.toString());
  }

  // Execute the split command
  await executeTmux(args);

  // Get the window ID from the target pane to list all panes
  const windowInfo = await executeTmux([
    "display-message",
    "-p",
    "-t",
    targetPaneId,
    "#{window_id}",
  ]);

  // List all panes in the window to find the newly created one
  const panes = await listPanes(windowInfo);

  // The newest pane is typically the last one in the list
  return panes.length > 0 ? panes[panes.length - 1] : null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = "TMUX_MCP_START";
const endMarkerPrefix = "TMUX_MCP_DONE_";

// Execute a command in a tmux pane and track its execution (OLD - for backward compat)
export async function executeCommandLegacy(
  paneId: string,
  command: string,
  rawMode?: boolean,
  noEnter?: boolean
): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  let fullCommand: string;
  if (rawMode || noEnter) {
    fullCommand = command;
  } else {
    const endMarkerText = getEndMarkerText();
    fullCommand = `echo "${startMarkerText}"; ${command}; echo "${endMarkerText}"`;
  }

  // Store command in tracking map
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: "pending",
    startTime: new Date(),
    rawMode: rawMode || noEnter,
  });

  // Send the command to the tmux pane
  if (noEnter) {
    // Check if this is a special key or key combination
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = [
      "Up",
      "Down",
      "Left",
      "Right",
      "Escape",
      "Tab",
      "Enter",
      "Space",
      "BSpace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
      "BTab",
    ];

    // Split the command into parts to handle combinations like "C-b" or "M-x"
    const parts = fullCommand.split("-");
    const isSpecialKey = parts.length === 1 && specialKeys.includes(parts[0]);
    const isKeyCombo =
      parts.length > 1 &&
      (parts[0] === "C" || // Control
        parts[0] === "M" || // Meta/Alt
        parts[0] === "S"); // Shift

    if (isSpecialKey || isKeyCombo) {
      // Send special key or key combination as-is
      const args = ["send-keys", "-t", paneId];
      args.push(...fullCommand.split(" "));
      await executeTmux(args);
    } else {
      // For regular text, send each character individually to ensure proper processing
      // This handles both single characters (like 'q', 'f') and strings (like 'beam')
      for (const char of fullCommand) {
        await executeTmux(["send-keys", "-t", paneId, char]);
      }
    }
  } else {
    await executeTmux(["send-keys", "-t", paneId, fullCommand, "Enter"]);
  }

  return commandId;
}

export async function checkCommandStatus(
  commandId: string
): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== "pending") return command;

  const content = await capturePaneContent(command.paneId, 1000);

  if (command.rawMode) {
    command.result =
      "Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.";
    return command;
  }

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split("\n")[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? "completed" : "error";
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex).trim();

    command.result = outputContent
      .substring(outputContent.indexOf("\n") + 1)
      .trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes =
      (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== "pending" && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function getEndMarkerText(): string {
  return shellConfig.type === "fish"
    ? `${endMarkerPrefix}$status`
    : `${endMarkerPrefix}$?`;
}

// New consolidated API functions

export type ListScope = "all" | "sessions" | "session" | "window" | "pane";

interface SessionWithWindows extends TmuxSession {
  windowDetails?: WindowWithPanes[];
}

interface WindowWithPanes extends TmuxWindow {
  paneDetails?: TmuxPane[];
}

export async function list({
  scope,
  target,
}: {
  scope: ListScope;
  target?: string;
}): Promise<
  | SessionWithWindows[]
  | TmuxSession[]
  | TmuxWindow[]
  | TmuxPane[]
  | TmuxSession
  | TmuxWindow
  | TmuxPane
> {
  if (scope === "all") {
    const sessions = await listSessions();
    const sessionsWithDetails: SessionWithWindows[] = [];

    for (const session of sessions) {
      const windows = await listWindows(session.id);
      const windowsWithPanes: WindowWithPanes[] = [];

      for (const window of windows) {
        const panes = await listPanes(window.id);
        windowsWithPanes.push({
          ...window,
          paneDetails: panes,
        });
      }

      sessionsWithDetails.push({
        ...session,
        windowDetails: windowsWithPanes,
      });
    }

    return sessionsWithDetails;
  }

  if (scope === "sessions") {
    return listSessions();
  }

  if (scope === "session") {
    if (!target) {
      throw new Error("target is required for scope 'session'");
    }
    return listWindows(target);
  }

  if (scope === "window") {
    if (!target) {
      throw new Error("target is required for scope 'window'");
    }
    return listPanes(target);
  }

  if (scope === "pane") {
    if (!target) {
      throw new Error("target is required for scope 'pane'");
    }
    const windowId = await executeTmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{window_id}",
    ]);
    const panes = await listPanes(windowId);
    const pane = panes.find((p) => p.id === target);
    if (!pane) {
      throw new Error(`Pane not found: ${target}`);
    }
    return pane;
  }

  throw new Error(`Invalid scope: ${scope}`);
}

export type KillScope = "session" | "window" | "pane";

export async function kill({
  scope,
  target,
}: {
  scope: KillScope;
  target: string;
}): Promise<void> {
  if (scope === "session") {
    return killSession(target);
  }

  if (scope === "window") {
    return killWindow(target);
  }

  if (scope === "pane") {
    return killPane(target);
  }

  throw new Error(`Invalid scope: ${scope}`);
}

export interface ShellCommandResult {
  command: string;
  status: "completed" | "error";
  exitCode: number;
  output: string;
}

export async function executeShellCommand({
  paneId,
  command,
  timeout = 30000,
}: {
  paneId: string;
  command: string;
  timeout?: number;
}): Promise<ShellCommandResult> {
  const commandId = uuidv4();
  const endMarkerText = getEndMarkerText();
  const fullCommand = `echo "${startMarkerText}"; ${command}; echo "${endMarkerText}"`;

  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: "pending",
    startTime: new Date(),
    rawMode: false,
  });

  await executeTmux(["send-keys", "-t", paneId, fullCommand, "Enter"]);

  // Poll for completion
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeout) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const result = await checkCommandStatus(commandId);

    if (result && result.status !== "pending") {
      // Cleanup
      activeCommands.delete(commandId);

      return {
        command: result.command,
        status: result.status,
        exitCode: result.exitCode!,
        output: result.result || "",
      };
    }
  }

  // Timeout
  activeCommands.delete(commandId);
  throw new Error(
    `Command timed out after ${timeout}ms. Use capture-pane to check pane state.`
  );
}

export async function sendKeys({
  paneId,
  keys,
  repeat = 1,
  return_output,
}: {
  paneId: string;
  keys: string;
  repeat?: number;
  return_output?: {
    lines?: number;
    waitForSettled?: boolean;
    maxWait?: number;
  };
}): Promise<string | null> {
  // Repeat the key press the specified number of times
  for (let i = 0; i < repeat; i++) {
    // Raw pass-through, no validation or processing
    const args = ["send-keys", "-t", paneId];
    args.push(...keys.split(" "));
    await executeTmux(args);
  }

  // If return_output is requested, wait and capture pane content
  if (return_output) {
    const lines = return_output.lines || 200;
    const waitForSettled = return_output.waitForSettled ?? true;
    const maxWait = return_output.maxWait ?? 120000; // 2 minutes default

    if (waitForSettled) {
      return waitForPaneActivityToSettle(paneId, maxWait, lines);
    } else {
      return capturePaneContent(paneId, lines, false);
    }
  }

  return null;
}

export async function waitForPaneActivityToSettle(
  paneId: string,
  maxWait: number,
  lines: number
): Promise<string> {
  const settleTime = 1000; // Hardcoded debounce
  const pollInterval = 100; // Poll every 100ms

  let lastContent = "";
  let lastChangeTime = Date.now();
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxWait) {
      // Timeout - return what we have
      return lastContent;
    }

    const content = await capturePaneContent(paneId, lines, false);

    if (content !== lastContent) {
      // Activity detected - reset settle timer
      lastContent = content;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime >= settleTime) {
      // No changes for settleTime ms - settled!
      return content;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

export async function sendText({
  paneId,
  text,
  pressEnter = false,
  return_output,
}: {
  paneId: string;
  text: string;
  pressEnter?: boolean;
  return_output?: {
    lines?: number;
    waitForSettled?: boolean;
    maxWait?: number;
  };
}): Promise<string | null> {
  // Send each character with -l flag for literal interpretation
  // Using execFile avoids shell interpretation of special characters like ; | & $
  for (const char of text) {
    await executeTmux(["send-keys", "-l", "-t", paneId, char]);
  }

  if (pressEnter) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await executeTmux(["send-keys", "-t", paneId, "Enter"]);
  }

  // If return_output is requested, wait and capture pane content
  if (return_output) {
    const lines = return_output.lines || 200;
    const waitForSettled = return_output.waitForSettled ?? true;
    const maxWait = return_output.maxWait ?? 120000; // 2 minutes default

    if (waitForSettled) {
      return waitForPaneActivityToSettle(paneId, maxWait, lines);
    } else {
      return capturePaneContent(paneId, lines, false);
    }
  }

  return null;
}
