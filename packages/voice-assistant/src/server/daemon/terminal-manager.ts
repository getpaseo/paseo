import {
  findSessionByName,
  createSession,
  listWindows,
  createWindow,
  capturePaneContent,
  sendText as tmuxSendText,
  renameWindow,
  killWindow,
  isWindowNameUnique,
  getCurrentWorkingDirectory,
  getCurrentCommand,
} from "./tmux.js";

const DEFAULT_SESSION = "voice-dev";

// Terminal model: session → windows (single pane per window)
// Terminal ID = window ID (format: @123)

export interface TerminalInfo {
  id: string; // window ID
  name: string;
  workingDirectory: string;
  currentCommand: string;
}

export interface CreateTerminalParams {
  name: string;
  workingDirectory: string;
  initialCommand?: string;
}

export interface Terminal extends TerminalInfo {
  active: boolean;
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
 * Returns terminal info including ID, name, working directory, and current command
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

      terminals.push({
        id: window.id,
        name: window.name,
        workingDirectory,
        currentCommand,
      });
    } catch (error) {
      // If we can't get pane info, still include the terminal with empty values
      terminals.push({
        id: window.id,
        name: window.name,
        workingDirectory: "",
        currentCommand: "",
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
    id: windowResult.id,
    name: windowResult.name,
    active: windowResult.active,
    sessionId: session.id,
    workingDirectory,
    currentCommand,
  };
}

/**
 * Capture output from a terminal
 * Returns the last N lines of terminal content
 */
export async function captureTerminal(
  terminalId: string,
  lines: number = 200,
  wait?: number
): Promise<string> {
  // Terminal ID is window ID, get the first pane
  const paneId = `${terminalId}.0`;

  // Optional wait before capture
  if (wait) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  return capturePaneContent(paneId, lines, false);
}

/**
 * Send text to a terminal, optionally press Enter, optionally return output
 */
export async function sendText(
  terminalId: string,
  text: string,
  pressEnter: boolean = false,
  return_output?: { lines?: number; wait?: number }
): Promise<string | void> {
  // Terminal ID is window ID, get the first pane
  const paneId = `${terminalId}.0`;

  return tmuxSendText({
    paneId,
    text,
    pressEnter,
    return_output,
  });
}

/**
 * Rename a terminal
 * Validates that the new name is unique
 */
export async function renameTerminal(
  terminalId: string,
  newName: string
): Promise<void> {
  const session = await findSessionByName(DEFAULT_SESSION);

  if (!session) {
    throw new Error(`Session '${DEFAULT_SESSION}' not found.`);
  }

  // renameWindow handles uniqueness validation internally
  await renameWindow(session.id, terminalId, newName);
}

/**
 * Kill (close/destroy) a terminal
 */
export async function killTerminal(terminalId: string): Promise<void> {
  await killWindow(terminalId);
}
