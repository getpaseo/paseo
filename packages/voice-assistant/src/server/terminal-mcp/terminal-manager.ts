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
  waitForPaneActivityToSettle,
} from "./tmux.js";

// Terminal model: session → windows (single pane per window)
// Terminals are identified by their unique names, not IDs

export interface TerminalInfo {
  name: string;
  workingDirectory: string;
  currentCommand: string;
  lastLines?: string;
}

export interface CreateTerminalParams {
  name: string;
  workingDirectory: string;
  initialCommand?: string;
}

export interface CreateTerminalResult extends TerminalInfo {
  commandOutput?: string;
}

/**
 * Terminal manager for a specific tmux session
 * Multiple instances can coexist with different session names
 */
export class TerminalManager {
  constructor(private sessionName: string) {}

  /**
   * Initialize the tmux session
   * Creates it if it doesn't exist
   */
  async initialize(): Promise<void> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      await createSession(this.sessionName);
    }
  }

  /**
   * List all terminals in the session
   * Returns terminal info including name, active status, working directory, and current command
   */
  async listTerminals(): Promise<TerminalInfo[]> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      throw new Error(
        `Session '${this.sessionName}' not found. Call initialize() first.`
      );
    }

    const windows = await listWindows(session.id);

    const terminals: TerminalInfo[] = [];

    for (const window of windows) {
      // Get the first (and only) pane in this window
      const paneId = `${window.id}.0`;

      const workingDirectory = await getCurrentWorkingDirectory(paneId);
      const currentCommand = await getCurrentCommand(paneId);
      const lastLines = await capturePaneContent(paneId, 5, false);

      terminals.push({
        name: window.name,
        workingDirectory,
        currentCommand,
        lastLines,
      });
    }

    return terminals;
  }

  /**
   * Create a new terminal (tmux window) with specified name and working directory
   * Optionally execute an initial command
   */
  async createTerminal(
    params: CreateTerminalParams
  ): Promise<CreateTerminalResult> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      throw new Error(
        `Session '${this.sessionName}' not found. Call initialize() first.`
      );
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
      workingDirectory,
      currentCommand,
      commandOutput: windowResult.output,
    };
  }

  /**
   * Capture output from a terminal by name
   * Returns the last N lines of terminal content
   * If maxWait is provided, waits for terminal activity to settle before capturing
   */
  async captureTerminal(
    terminalName: string,
    lines: number = 200,
    maxWait?: number
  ): Promise<string> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
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

    // Wait for activity to settle if maxWait is provided
    if (maxWait) {
      return waitForPaneActivityToSettle(pane.id, maxWait, lines);
    }

    return capturePaneContent(pane.id, lines, false);
  }

  /**
   * Send text to a terminal by name, optionally press Enter, optionally return output
   */
  async sendText(
    terminalName: string,
    text: string,
    pressEnter: boolean = false,
    return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
  ): Promise<string | void> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
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
  async sendKeys(
    terminalName: string,
    keys: string,
    repeat: number = 1,
    return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
  ): Promise<string | void> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
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
  async renameTerminal(
    terminalName: string,
    newName: string
  ): Promise<void> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
    }

    // renameWindow handles uniqueness validation and name resolution internally
    await renameWindow(session.id, terminalName, newName);
  }

  /**
   * Kill (close/destroy) a terminal by name
   */
  async killTerminal(terminalName: string): Promise<void> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
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
}
