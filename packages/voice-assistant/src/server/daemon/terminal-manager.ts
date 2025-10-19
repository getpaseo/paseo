import {
  findSessionByName,
  createSession,
  listWindows,
  createWindow,
  listPanes,
  findWindowByName,
  capturePaneContent,
  sendText as tmuxSendText,
  sendKeys as tmuxSendKeys,
  renameWindow,
  killWindow,
  isWindowNameUnique,
  getCurrentWorkingDirectory,
  getCurrentCommand,
} from "./tmux.js";

const DEFAULT_SESSION = "voice-dev";

// Terminal model: session → windows (single pane per window)
// Terminals are identified by their unique names, not IDs

export interface TerminalInfo {
  name: string;
  active: boolean;
  workingDirectory: string;
  currentCommand: string;
  lastLines?: string;
}

export interface CreateTerminalParams {
  name: string;
  workingDirectory: string;
  initialCommand?: string;
}

export interface Terminal extends TerminalInfo {
  sessionId: string;
}

/**
 * Initialize the default "voice-dev" tmux session
 * Creates it if it doesn't exist
 */
export async function initializeDefaultSession(): Promise<void> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    await createSession(DEFAULT_SESSION);
  }
}

/**
 * List all terminals in the voice-dev session
 * Returns terminal info including name, active status, working directory, and current command
 */
export async function listTerminals(): Promise<TerminalInfo[]> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found. Call initializeDefaultSession() first.`);
  }

  const windows = await listWindows(session.id);

  const terminals: TerminalInfo[] = [];

  for (const window of windows) {
    // Get the first (and only) pane in this window
    const paneId = `${window.id}.0`;

    try {
      const workingDirectory = await getCurrentWorkingDirectory(paneId);
      const currentCommand = await getCurrentCommand(paneId);
      const lastLines = await capturePaneContent(paneId, 5, false);

      terminals.push({
        name: window.name,
        active: window.active,
        workingDirectory,
        currentCommand,
        lastLines,
      });
    } catch (error) {
      // If we can't get pane info, still include the terminal with empty values
      terminals.push({
        name: window.name,
        active: window.active,
        workingDirectory: "",
        currentCommand: "",
        lastLines: "",
      });
    }
  }

  return terminals;
}

/**
 * Create a new terminal (tmux window) with specified name and working directory
 * Optionally execute an initial command
 */
export async function createTerminal(params: CreateTerminalParams): Promise<Terminal> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found. Call initializeDefaultSession() first.`);
  }

  // Validate name uniqueness
  const isUnique = await isWindowNameUnique(session.id, params.name);
  if (!isUnique) {
    throw new Error(
      `Terminal with name '${params.name}' already exists. Please choose a unique name.`
    );
  }

  // Create the window
  const windowResult = await createWindow(session.id, params.name, {
    workingDirectory: params.workingDirectory,
    command: params.initialCommand,
  });

  if (!windowResult) {
    throw new Error(`Failed to create terminal '${params.name}'`);
  }

  const paneId = windowResult.paneId;

  // Get terminal info
  const workingDirectory = await getCurrentWorkingDirectory(paneId);
  const currentCommand = await getCurrentCommand(paneId);

  return {
    name: windowResult.name,
    active: windowResult.active,
    workingDirectory,
    currentCommand,
    sessionId: session.id,
  };
}

/**
 * Capture output from a terminal by name
 * Returns the last N lines of terminal content
 */
export async function captureTerminal(
  terminalName: string,
  lines: number = 200,
  wait?: number
): Promise<string> {
  const session = await findSessionByName(DEFAULT_SESSION);
  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // Resolve terminal name to window
  const window = await findWindowByName(session.id, terminalName);
  if (!window) {
    const windows = await listWindows(session.id);
    const availableNames = windows.map((w) => w.name).join(", ");
    throw new Error(
      `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
    );
  }

  // Get the first pane
  const panes = await listPanes(window.id);
  const pane = panes[0];
  if (!pane) {
    throw new Error(`No pane found for terminal ${terminalName}`);
  }

  // Optional wait before capture
  if (wait) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  return capturePaneContent(pane.id, lines, false);
}

/**
 * Send text to a terminal by name, optionally press Enter, optionally return output
 */
export async function sendText(
  terminalName: string,
  text: string,
  pressEnter: boolean = false,
  return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
): Promise<string | void> {
  const session = await findSessionByName(DEFAULT_SESSION);
  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // Resolve terminal name to window
  const window = await findWindowByName(session.id, terminalName);
  if (!window) {
    const windows = await listWindows(session.id);
    const availableNames = windows.map((w) => w.name).join(", ");
    throw new Error(
      `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
    );
  }

  // Get the first pane
  const panes = await listPanes(window.id);
  const pane = panes[0];
  if (!pane) {
    throw new Error(`No pane found for terminal ${terminalName}`);
  }

  return tmuxSendText({
    paneId: pane.id,
    text,
    pressEnter,
    return_output,
  });
}

/**
 * Send special keys or key combinations to a terminal by name
 * Useful for TUI navigation, control sequences, and interactive applications
 */
export async function sendKeys(
  terminalName: string,
  keys: string,
  repeat: number = 1,
  return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
): Promise<string | void> {
  const session = await findSessionByName(DEFAULT_SESSION);
  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // Resolve terminal name to window
  const window = await findWindowByName(session.id, terminalName);
  if (!window) {
    const windows = await listWindows(session.id);
    const availableNames = windows.map((w) => w.name).join(", ");
    throw new Error(
      `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
    );
  }

  // Get the first pane
  const panes = await listPanes(window.id);
  const pane = panes[0];
  if (!pane) {
    throw new Error(`No pane found for terminal ${terminalName}`);
  }

  return tmuxSendKeys({
    paneId: pane.id,
    keys,
    repeat,
    return_output,
  });
}

/**
 * Rename a terminal by name
 * Validates that the new name is unique
 */
export async function renameTerminal(
  terminalName: string,
  newName: string
): Promise<void> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // renameWindow handles uniqueness validation and name resolution internally
  await renameWindow(session.id, terminalName, newName);
}

/**
 * Kill (close/destroy) a terminal by name
 */
export async function killTerminal(terminalName: string): Promise<void> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // Resolve terminal name to window
  const window = await findWindowByName(session.id, terminalName);
  if (!window) {
    const windows = await listWindows(session.id);
    const availableNames = windows.map((w) => w.name).join(", ");
    throw new Error(
      `Terminal '${terminalName}' not found. Available terminals: ${availableNames}`
    );
  }

  await killWindow(window.id);
}
