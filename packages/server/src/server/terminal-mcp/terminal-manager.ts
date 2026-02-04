import {
  findSessionByName,
  createSession,
  listWindows,
  createWindow,
  listPanes,
  findWindowByName,
  capturePaneContent,
  extractExitCodeMarkerFromOutput,
  sendText as tmuxSendText,
  sendKeys as tmuxSendKeys,
  renameWindow,
  killWindow,
  isWindowNameUnique,
  getCurrentWorkingDirectory,
  getCurrentCommand,
  getStoredWorkingDirectory,
  getStoredCommand,
  waitForPaneActivityToSettle,
  executeCommand as tmuxExecuteCommand,
  executeTmux,
} from "./tmux.js";

// Terminal model: session → windows (single pane per window)
// Terminals are identified by their unique names, not IDs

export interface TerminalInfo {
  name: string;
  workingDirectory: string;
  currentCommand: string;
  lastLines: string | null;
}

export interface CommandInfo {
  id: string;
  name: string;
  workingDirectory: string;
  currentCommand: string;
  isDead: boolean;
  exitCode: number | null;
  lastLines: string | null;
}

export interface CreateTerminalParams {
  name: string;
  workingDirectory: string;
  initialCommand?: string;
}

export interface CreateTerminalResult extends TerminalInfo {
  commandOutput: string | null;
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
        lastLines: lastLines || null,
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
      command: params.initialCommand ?? null,
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
      commandOutput: windowResult.output || null,
      lastLines: null,
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
  ): Promise<string | null> {
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
  ): Promise<string | null> {
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

  /**
   * Execute a command and return its output, exit code, and running status
   * Commands are wrapped in bash -c to support all bash features
   * Windows remain after command exits (remain-on-exit) for inspection
   */
  async executeCommand(
    command: string,
    workingDirectory: string,
    maxWait?: number
  ): Promise<{
    commandId: string;
    output: string;
    exitCode: number | null;
    isDead: boolean;
  }> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(
        `Session '${this.sessionName}' not found. Call initialize() first.`
      );
    }

    const result = await tmuxExecuteCommand({
      sessionId: session.id,
      command,
      workingDirectory,
      maxWait,
    });

    return {
      commandId: result.windowId,
      output: result.output,
      exitCode: result.exitCode,
      isDead: result.isDead,
    };
  }

  /**
   * List all commands (windows), including those that have exited
   * Shows both running and dead commands for inspection
   */
  async listCommands(): Promise<CommandInfo[]> {
    const session = await findSessionByName(this.sessionName);

    if (!session) {
      throw new Error(
        `Session '${this.sessionName}' not found. Call initialize() first.`
      );
    }

    const windows = await listWindows(session.id);
    const commands: CommandInfo[] = [];

    for (const window of windows) {
      const paneId = `${window.id}.0`;

      // Check if pane is dead first
      const deadStatus = await executeTmux([
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_dead}",
      ]);
      const isDead = deadStatus === "1";

      // Use stored values for dead panes, current values for live ones
      const workingDirectory = await getStoredWorkingDirectory(window.id, paneId);
      const currentCommand = await getStoredCommand(window.id, paneId);
      const rawLastLines = await capturePaneContent(paneId, 5, false);
      const lastLinesExtracted = extractExitCodeMarkerFromOutput(rawLastLines);
      const lastLines = lastLinesExtracted.output;

      let exitCode: number | null = null;
      if (isDead) {
        const exitCodeStr = await executeTmux([
          "display-message",
          "-p",
          "-t",
          paneId,
          "#{pane_dead_status}",
        ]);
        const parsed = parseInt(exitCodeStr, 10);
        exitCode = Number.isFinite(parsed) ? parsed : lastLinesExtracted.exitCode;
      }

      commands.push({
        id: window.id,
        name: window.name,
        workingDirectory,
        currentCommand,
        isDead,
        exitCode,
        lastLines: lastLines || null,
      });
    }

    return commands;
  }

  /**
   * Capture output from a command by ID (window ID)
   */
  async captureCommand(
    commandId: string,
    lines: number = 200
  ): Promise<{
    output: string;
    exitCode: number | null;
    isDead: boolean;
  }> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
    }

      const paneId = `${commandId}.0`;

    const rawOutput = await capturePaneContent(paneId, lines, false);
    const extracted = extractExitCodeMarkerFromOutput(rawOutput);
    const output = extracted.output;

    const deadStatus = await executeTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_dead}",
    ]);
    const isDead = deadStatus === "1";

    let exitCode: number | null = null;
    if (isDead) {
      const exitCodeStr = await executeTmux([
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_dead_status}",
      ]);
      const parsed = parseInt(exitCodeStr, 10);
      exitCode = Number.isFinite(parsed) ? parsed : extracted.exitCode;
    }

    return {
      output,
      exitCode,
      isDead,
    };
  }

  /**
   * Send text to a command by ID (window ID)
   */
  async sendTextToCommand(
    commandId: string,
    text: string,
    pressEnter: boolean = false,
    return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
  ): Promise<string | null> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
    }

    const paneId = `${commandId}.0`;

    return tmuxSendText({
      paneId,
      text,
      pressEnter,
      return_output,
    });
  }

  /**
   * Send keys to a command by ID (window ID)
   */
  async sendKeysToCommand(
    commandId: string,
    keys: string,
    repeat: number = 1,
    return_output?: { lines?: number; waitForSettled?: boolean; maxWait?: number }
  ): Promise<string | null> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
    }

    const paneId = `${commandId}.0`;

    return tmuxSendKeys({
      paneId,
      keys,
      repeat,
      return_output,
    });
  }

  /**
   * Kill a command by ID (window ID)
   */
  async killCommand(commandId: string): Promise<void> {
    const session = await findSessionByName(this.sessionName);
    if (!session) {
      throw new Error(`Session '${this.sessionName}' not found.`);
    }

    await killWindow(commandId);
  }
}
