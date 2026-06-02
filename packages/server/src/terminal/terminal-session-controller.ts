import type pino from "pino";
import type {
  CaptureTerminalRequest,
  CreateTerminalRequest,
  KillTerminalRequest,
  ListTerminalsRequest,
  RenameTerminalRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
  SubscribeTerminalRequest,
  SubscribeTerminalsRequest,
  TerminalInput,
  UnsubscribeTerminalRequest,
  UnsubscribeTerminalsRequest,
} from "../server/messages.js";
import { killTerminalsUnderPath as killWorktreeTerminalsUnderPath } from "../server/paseo-worktree-archive-service.js";
import {
  TerminalStreamOpcode,
  decodeTerminalResizePayload,
  encodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";
import {
  MAX_TERMINAL_OUTPUT_FRAME_BYTES,
  encodeLegacyTerminalSnapshotFrame,
  encodeTerminalRestoreFrame,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
  resolveTerminalSubscriptionSnapshotMode,
  type TerminalRestoreOptions,
} from "./terminal-restore.js";
import type { TerminalSession } from "./terminal.js";
import type { TerminalManager, TerminalsChangedEvent } from "./terminal-manager.js";

const MAX_TERMINAL_STREAM_SLOTS = 256;

interface BufferedTerminalOutput {
  data: string;
  revision?: number;
}

interface ActiveTerminalStream {
  terminalId: string;
  slot: number;
  unsubscribe: () => void;
  needsSnapshot: boolean;
  snapshotInFlight: boolean;
  readyRevision?: number;
  restore?: TerminalRestoreOptions;
  bufferedOutputs: BufferedTerminalOutput[];
  outputBytesSinceSnapshot: number;
  outputCoalescer: TerminalOutputCoalescer;
}

interface SnapshotSendResult {
  shouldContinue: boolean;
  replayRevision?: number;
}

export interface TerminalSessionControllerOptions {
  terminalManager: TerminalManager | null;
  emit: (msg: SessionOutboundMessage) => void;
  emitBinary: (frame: Uint8Array) => void;
  hasBinaryChannel: () => boolean;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  sessionLogger: pino.Logger;
  listTerminalWorkspaceRoots?: () => Promise<readonly string[]>;
  // Whether the connected client can reflow restored snapshots. When true the
  // daemon attaches per-row soft-wrap flags to snapshots; otherwise it omits them
  // so old (strict-schema) clients still parse the snapshot.
  clientSupportsWrapReflow?: () => boolean;
}

export interface TerminalSessionControllerMetrics {
  directorySubscriptionCount: number;
  streamSubscriptionCount: number;
}

type TerminalDispatchableMessage =
  | SubscribeTerminalsRequest
  | UnsubscribeTerminalsRequest
  | ListTerminalsRequest
  | CreateTerminalRequest
  | SubscribeTerminalRequest
  | UnsubscribeTerminalRequest
  | TerminalInput
  | KillTerminalRequest
  | CaptureTerminalRequest
  | RenameTerminalRequest;

const TERMINAL_MESSAGE_TYPES: ReadonlySet<TerminalDispatchableMessage["type"]> = new Set([
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
  "list_terminals_request",
  "create_terminal_request",
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "terminal_input",
  "kill_terminal_request",
  "capture_terminal_request",
  "terminal.rename.request",
]);

export class TerminalSessionController {
  private readonly terminalManager: TerminalManager | null;
  private readonly emit: (msg: SessionOutboundMessage) => void;
  private readonly emitBinary: (frame: Uint8Array) => void;
  private readonly hasBinaryChannel: () => boolean;
  private readonly isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  private readonly sessionLogger: pino.Logger;
  private readonly listTerminalWorkspaceRoots: () => Promise<readonly string[]>;
  private readonly clientSupportsWrapReflow: () => boolean;

  private readonly subscribedDirectories = new Set<string>();
  private unsubscribeTerminalsChanged: (() => void) | null = null;
  private readonly exitSubscriptions = new Map<string, () => void>();
  private readonly activeStreams = new Map<number, ActiveTerminalStream>();
  private readonly idToSlot = new Map<string, number>();
  private nextSlot = 0;

  constructor(options: TerminalSessionControllerOptions) {
    this.terminalManager = options.terminalManager;
    this.emit = options.emit;
    this.emitBinary = options.emitBinary;
    this.hasBinaryChannel = options.hasBinaryChannel;
    this.isPathWithinRoot = options.isPathWithinRoot;
    this.sessionLogger = options.sessionLogger;
    this.listTerminalWorkspaceRoots = options.listTerminalWorkspaceRoots ?? (async () => []);
    this.clientSupportsWrapReflow = options.clientSupportsWrapReflow ?? (() => false);
  }

  start(): void {
    if (!this.terminalManager) {
      return;
    }
    this.unsubscribeTerminalsChanged = this.terminalManager.subscribeTerminalsChanged((event) => {
      void this.handleTerminalsChanged(event);
    });
  }

  getMetrics(): TerminalSessionControllerMetrics {
    return {
      directorySubscriptionCount: this.subscribedDirectories.size,
      streamSubscriptionCount: this.activeStreams.size,
    };
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!isTerminalMessage(msg)) {
      return undefined;
    }
    switch (msg.type) {
      case "subscribe_terminals_request":
        this.handleSubscribeTerminalsRequest(msg);
        return undefined;
      case "unsubscribe_terminals_request":
        this.handleUnsubscribeTerminalsRequest(msg);
        return undefined;
      case "list_terminals_request":
        return this.handleListTerminalsRequest(msg);
      case "create_terminal_request":
        return this.handleCreateTerminalRequest(msg);
      case "subscribe_terminal_request":
        return this.handleSubscribeTerminalRequest(msg);
      case "unsubscribe_terminal_request":
        this.handleUnsubscribeTerminalRequest(msg);
        return undefined;
      case "terminal_input":
        this.handleTerminalInput(msg);
        return undefined;
      case "kill_terminal_request":
        return this.handleKillTerminalRequest(msg);
      case "capture_terminal_request":
        return this.handleCaptureTerminalRequest(msg);
      case "terminal.rename.request":
        return this.handleRenameTerminalRequest(msg);
      default:
        return undefined;
    }
  }

  handleBinaryFrame(frame: TerminalStreamFrame): void {
    const activeStream = this.activeStreams.get(frame.slot);
    if (!activeStream || !this.terminalManager) {
      return;
    }
    const terminal = this.terminalManager.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }

    switch (frame.opcode) {
      case TerminalStreamOpcode.Input: {
        if (frame.payload.byteLength === 0) {
          return;
        }
        const text = Buffer.from(frame.payload).toString("utf8");
        if (!text) {
          return;
        }
        terminal.send({ type: "input", data: text });
        return;
      }

      case TerminalStreamOpcode.Resize: {
        const resize = decodeTerminalResizePayload(frame.payload);
        if (!resize) {
          return;
        }
        terminal.send({ type: "resize", rows: resize.rows, cols: resize.cols });
        return;
      }

      default:
        return;
    }
  }

  killTerminalForClose(terminalId: string): { terminalId: string; success: boolean } {
    if (!this.terminalManager) {
      return { terminalId, success: false };
    }
    this.killTracked(terminalId, { emitExit: true });
    return { terminalId, success: true };
  }

  async killTerminalsUnderPath(rootPath: string): Promise<void> {
    return killWorktreeTerminalsUnderPath(
      {
        isPathWithinRoot: (pathRoot, candidatePath) =>
          this.isPathWithinRoot(pathRoot, candidatePath),
        killTrackedTerminal: (terminalId, options) => this.killTracked(terminalId, options),
        detachTerminalStream: (terminalId, options) => void this.detachStream(terminalId, options),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
      },
      rootPath,
    );
  }

  dispose(): void {
    if (this.unsubscribeTerminalsChanged) {
      this.unsubscribeTerminalsChanged();
      this.unsubscribeTerminalsChanged = null;
    }
    this.subscribedDirectories.clear();

    for (const unsubscribeExit of this.exitSubscriptions.values()) {
      unsubscribeExit();
    }
    this.exitSubscriptions.clear();

    for (const terminalId of Array.from(this.idToSlot.keys())) {
      this.detachStream(terminalId, { emitExit: false });
    }
  }

  private ensureExitSubscription(terminal: TerminalSession): void {
    if (this.exitSubscriptions.has(terminal.id)) {
      return;
    }
    const unsubscribeExit = terminal.onExit(() => {
      this.handleTerminalExited(terminal.id);
    });
    this.exitSubscriptions.set(terminal.id, unsubscribeExit);
  }

  private handleTerminalExited(terminalId: string): void {
    const unsubscribeExit = this.exitSubscriptions.get(terminalId);
    if (unsubscribeExit) {
      unsubscribeExit();
      this.exitSubscriptions.delete(terminalId);
    }
    this.detachStream(terminalId, { emitExit: true });
  }

  private emitTerminalsChangedSnapshot(input: {
    cwd: string;
    terminals: Array<{ id: string; name: string; title?: string }>;
  }): void {
    this.emit({
      type: "terminals_changed",
      payload: {
        cwd: input.cwd,
        terminals: input.terminals,
      },
    });
  }

  private toTerminalInfo(terminal: Pick<TerminalSession, "id" | "name" | "getTitle">): {
    id: string;
    name: string;
    title?: string;
  } {
    const title = terminal.getTitle();
    return {
      id: terminal.id,
      name: terminal.name,
      ...(title ? { title } : {}),
    };
  }

  private async handleTerminalsChanged(event: TerminalsChangedEvent): Promise<void> {
    // A terminal can live in a subdirectory of a subscribed workspace root (an
    // agent can open one there). Deliver the change to every subscribed root at
    // or above the terminal's cwd, keyed by that root, carrying the full
    // aggregated list — so the client's cache replacement doesn't drop the
    // terminals that live directly at the root.
    const matchingRoots = Array.from(this.subscribedDirectories).filter((root) =>
      this.isPathWithinRoot(root, event.cwd),
    );
    for (const root of matchingRoots) {
      await this.emitTerminalsSnapshotForRoot(root);
    }
  }

  private handleSubscribeTerminalsRequest(msg: SubscribeTerminalsRequest): void {
    this.subscribedDirectories.add(msg.cwd);
    void this.emitTerminalsSnapshotForRoot(msg.cwd);
  }

  private handleUnsubscribeTerminalsRequest(msg: UnsubscribeTerminalsRequest): void {
    this.subscribedDirectories.delete(msg.cwd);
  }

  private async emitTerminalsSnapshotForRoot(cwd: string): Promise<void> {
    if (!this.terminalManager || !this.subscribedDirectories.has(cwd)) {
      return;
    }
    try {
      const terminals = await this.getTerminalsForWorkspaceRoot(cwd);
      for (const terminal of terminals) {
        this.ensureExitSubscription(terminal);
      }
      if (!this.subscribedDirectories.has(cwd)) {
        return;
      }
      this.emitTerminalsChangedSnapshot({
        cwd,
        terminals: terminals.map((terminal) => this.toTerminalInfo(terminal)),
      });
    } catch (error) {
      this.sessionLogger.warn({ err: error, cwd }, "Failed to emit initial terminal snapshot");
    }
  }

  private async handleListTerminalsRequest(msg: ListTerminalsRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      const terminals =
        typeof msg.cwd === "string"
          ? await this.getTerminalsForWorkspaceRoot(msg.cwd)
          : await this.getAllTerminalSessions();
      for (const terminal of terminals) {
        this.ensureExitSubscription(terminal);
      }
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: terminals.map((terminal) => this.toTerminalInfo(terminal)),
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to list terminals");
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
    }
  }

  private async getAllTerminalSessions(): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }
    const directories = this.terminalManager.listDirectories();
    const manager = this.terminalManager;
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => manager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat();
  }

  private async getTerminalsForWorkspaceRoot(cwd: string): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }

    const terminals = await this.terminalManager.getTerminals(cwd);
    const workspaceRoots = await this.listTerminalWorkspaceRoots();
    if (workspaceRoots.length === 0) {
      return terminals;
    }

    return terminals.filter((terminal) =>
      this.terminalBelongsToRoot(cwd, terminal.cwd, workspaceRoots),
    );
  }

  private terminalBelongsToRoot(
    rootCwd: string,
    terminalCwd: string,
    workspaceRoots: readonly string[],
  ): boolean {
    const ownerRoot = this.resolveTerminalOwnerRoot(terminalCwd, workspaceRoots);
    if (!ownerRoot) {
      return this.isPathWithinRoot(rootCwd, terminalCwd);
    }
    return this.isSamePath(rootCwd, ownerRoot);
  }

  private resolveTerminalOwnerRoot(
    terminalCwd: string,
    workspaceRoots: readonly string[],
  ): string | null {
    let ownerRoot: string | null = null;
    for (const workspaceRoot of workspaceRoots) {
      if (!this.isPathWithinRoot(workspaceRoot, terminalCwd)) {
        continue;
      }
      if (!ownerRoot || workspaceRoot.length > ownerRoot.length) {
        ownerRoot = workspaceRoot;
      }
    }
    return ownerRoot;
  }

  private isSamePath(firstPath: string, secondPath: string): boolean {
    return (
      this.isPathWithinRoot(firstPath, secondPath) && this.isPathWithinRoot(secondPath, firstPath)
    );
  }

  private async handleCreateTerminalRequest(msg: CreateTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      if (msg.agentId) {
        this.emit({
          type: "create_terminal_response",
          payload: {
            terminal: null,
            error: `Agent-backed terminals are no longer supported for agent ${msg.agentId}`,
            requestId: msg.requestId,
          },
        });
        return;
      }

      const session = await this.terminalManager.createTerminal({
        cwd: msg.cwd,
        name: msg.name,
        command: msg.command,
        args: msg.args,
      });
      this.ensureExitSubscription(session);
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            ...(session.getTitle() ? { title: session.getTitle() } : {}),
          },
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to create terminal");
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: (error as Error).message,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async handleRenameTerminalRequest(msg: RenameTerminalRequest): Promise<void> {
    const respond = (success: boolean, error: string | null): void => {
      this.emit({
        type: "terminal.rename.response",
        payload: { requestId: msg.requestId, success, error },
      });
    };

    const title = msg.title.trim();
    if (title.length === 0) {
      respond(false, "Title is required");
      return;
    }
    if (title.length > 200) {
      respond(false, "Title is too long");
      return;
    }
    if (!this.terminalManager) {
      respond(false, "Terminal manager not available");
      return;
    }

    const renamed = this.terminalManager.setTerminalTitle(msg.terminalId, title);
    respond(renamed, renamed ? null : "Terminal not found");
  }

  private async handleSubscribeTerminalRequest(msg: SubscribeTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal not found",
          requestId: msg.requestId,
        },
      });
      return;
    }
    this.ensureExitSubscription(session);

    if (msg.restore?.size) {
      const currentSize = session.getSize();
      if (
        currentSize.rows !== msg.restore.size.rows ||
        currentSize.cols !== msg.restore.size.cols
      ) {
        session.send({
          type: "resize",
          rows: msg.restore.size.rows,
          cols: msg.restore.size.cols,
        });
      }
    }

    const slot = this.bindActiveStream(session, { restore: msg.restore });
    if (slot === null) {
      this.sessionLogger.warn(
        {
          terminalId: msg.terminalId,
          activeTerminalStreamCount: this.activeStreams.size,
        },
        "Terminal stream slot exhaustion",
      );
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "No terminal stream slots available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.emit({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        slot,
        error: null,
        requestId: msg.requestId,
      },
    });

    const activeStream = this.activeStreams.get(slot);
    if (activeStream) {
      void this.trySendSnapshot(activeStream);
    }
  }

  private handleUnsubscribeTerminalRequest(msg: UnsubscribeTerminalRequest): void {
    this.detachStream(msg.terminalId, { emitExit: false });
  }

  private handleTerminalInput(msg: TerminalInput): void {
    if (!this.terminalManager) {
      return;
    }
    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.sessionLogger.warn({ terminalId: msg.terminalId }, "Terminal not found for input");
      return;
    }
    this.ensureExitSubscription(session);

    if (msg.message.type === "resize") {
      const currentSize = session.getSize();
      if (currentSize.rows === msg.message.rows && currentSize.cols === msg.message.cols) {
        return;
      }
    }

    session.send(msg.message);
  }

  private killTracked(terminalId: string, options?: { emitExit: boolean }): void {
    this.detachStream(terminalId, { emitExit: options?.emitExit ?? true });
    this.terminalManager?.killTerminal(terminalId);
  }

  private async handleKillTerminalRequest(msg: KillTerminalRequest): Promise<void> {
    const result = this.killTerminalForClose(msg.terminalId);
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: result.terminalId,
        success: result.success,
        requestId: msg.requestId,
      },
    });
  }

  private async handleCaptureTerminalRequest(msg: CaptureTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.ensureExitSubscription(session);

    try {
      const capture = await this.terminalManager.captureTerminal(msg.terminalId, {
        start: msg.start,
        end: msg.end,
        stripAnsi: msg.stripAnsi,
      });
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, terminalId: msg.terminalId },
        "Failed to capture terminal",
      );
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
    }
  }

  private bindActiveStream(
    terminal: TerminalSession,
    options?: { restore?: TerminalRestoreOptions },
  ): number | null {
    if (!this.hasBinaryChannel()) {
      return null;
    }

    const existingSlot = this.idToSlot.get(terminal.id);
    if (typeof existingSlot === "number") {
      const existingStream = this.activeStreams.get(existingSlot);
      if (existingStream) {
        existingStream.needsSnapshot = true;
        existingStream.restore = options?.restore;
        return existingSlot;
      }
      this.idToSlot.delete(terminal.id);
    }

    const slot = this.allocateSlot();
    if (slot === null) {
      return null;
    }

    const activeStream: ActiveTerminalStream = {
      terminalId: terminal.id,
      slot,
      unsubscribe: () => {},
      needsSnapshot: true,
      snapshotInFlight: false,
      readyRevision: undefined,
      restore: options?.restore,
      bufferedOutputs: [],
      outputBytesSinceSnapshot: 0,
      outputCoalescer: new TerminalOutputCoalescer({
        timers: { setTimeout, clearTimeout },
        onFlush: ({ payload }) => {
          if (this.activeStreams.get(slot) !== activeStream) {
            return;
          }
          activeStream.outputBytesSinceSnapshot += payload.byteLength;
          if (activeStream.outputBytesSinceSnapshot > MAX_TERMINAL_OUTPUT_FRAME_BYTES) {
            activeStream.restore = resolveRestoreAfterOutputOverflow(activeStream.restore);
            activeStream.needsSnapshot = true;
            void this.trySendSnapshot(activeStream);
            return;
          }
          this.emitBinary(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Output,
              slot,
              payload,
            }),
          );
        },
      }),
    };

    this.activeStreams.set(slot, activeStream);
    this.idToSlot.set(terminal.id, slot);

    activeStream.unsubscribe = terminal.subscribe(
      (message) => {
        if (this.activeStreams.get(slot) !== activeStream) {
          return;
        }
        if (message.type === "snapshot" || message.type === "snapshotReady") {
          activeStream.readyRevision = message.revision;
          activeStream.outputCoalescer.flush();
          activeStream.needsSnapshot = true;
          void this.trySendSnapshot(activeStream);
          return;
        }
        if (message.type === "titleChange") {
          return;
        }
        if (message.data.length === 0) {
          return;
        }
        if (activeStream.needsSnapshot || activeStream.snapshotInFlight) {
          activeStream.bufferedOutputs.push({
            data: message.data,
            revision: message.revision,
          });
          return;
        }
        activeStream.outputCoalescer.handle(message.data);
      },
      { initialSnapshot: resolveTerminalSubscriptionSnapshotMode(options?.restore) },
    );
    return slot;
  }

  private async trySendSnapshot(activeStream: ActiveTerminalStream): Promise<void> {
    if (
      this.activeStreams.get(activeStream.slot) !== activeStream ||
      !activeStream.needsSnapshot ||
      activeStream.snapshotInFlight
    ) {
      return;
    }

    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }
    const terminal = terminalManager.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }
    if (activeStream.restore && activeStream.readyRevision === undefined) {
      return;
    }

    activeStream.outputCoalescer.flush();
    activeStream.snapshotInFlight = true;
    try {
      const restore = activeStream.restore;
      const snapshotResult = restore
        ? await this.emitRestoreSnapshot(activeStream, terminalManager, restore)
        : await this.emitLegacySnapshot(activeStream, terminalManager);
      if (!snapshotResult.shouldContinue) {
        return;
      }
      this.replayTerminalOutputAfterSnapshot(activeStream, terminal, snapshotResult.replayRevision);
      activeStream.needsSnapshot = false;
      activeStream.outputBytesSinceSnapshot = 0;
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, terminalId: activeStream.terminalId },
        "Failed to pull terminal snapshot",
      );
      activeStream.needsSnapshot = true;
    } finally {
      activeStream.snapshotInFlight = false;
    }
  }

  private async emitLegacySnapshot(
    activeStream: ActiveTerminalStream,
    terminalManager: TerminalManager,
  ): Promise<SnapshotSendResult> {
    const snapshot = await terminalManager.getTerminalState(activeStream.terminalId, {
      includeWrapFlags: this.clientSupportsWrapReflow(),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    this.emitBinary(
      encodeLegacyTerminalSnapshotFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    return { shouldContinue: true, replayRevision: snapshot.revision };
  }

  private async emitRestoreSnapshot(
    activeStream: ActiveTerminalStream,
    terminalManager: TerminalManager,
    restore: TerminalRestoreOptions,
  ): Promise<SnapshotSendResult> {
    const snapshotOptions = resolveTerminalRestoreSnapshotOptions(restore);
    if (snapshotOptions === null) {
      return { shouldContinue: true };
    }

    const snapshot = await terminalManager.getTerminalState(activeStream.terminalId, {
      ...snapshotOptions,
      includeWrapFlags: this.clientSupportsWrapReflow(),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    this.emitBinary(
      encodeTerminalRestoreFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    return { shouldContinue: true, replayRevision: snapshot.revision };
  }

  private replayTerminalOutputAfterSnapshot(
    activeStream: ActiveTerminalStream,
    terminal: TerminalSession,
    replayRevision: number | undefined,
  ): void {
    const replayPreamble = terminal.getReplayPreamble();
    if (replayPreamble.length > 0) {
      activeStream.outputCoalescer.handle(replayPreamble);
    }

    const bufferedOutputs = activeStream.bufferedOutputs.splice(
      0,
      activeStream.bufferedOutputs.length,
    );
    for (const output of bufferedOutputs) {
      if (
        replayRevision !== undefined &&
        output.revision !== undefined &&
        output.revision <= replayRevision
      ) {
        continue;
      }
      activeStream.outputCoalescer.handle(output.data);
    }
  }

  private allocateSlot(): number | null {
    for (let attempt = 0; attempt < MAX_TERMINAL_STREAM_SLOTS; attempt += 1) {
      const slot = (this.nextSlot + attempt) % MAX_TERMINAL_STREAM_SLOTS;
      if (this.activeStreams.has(slot)) {
        continue;
      }
      this.nextSlot = (slot + 1) % MAX_TERMINAL_STREAM_SLOTS;
      return slot;
    }
    return null;
  }

  private detachStream(terminalId: string, options?: { emitExit: boolean }): boolean {
    const slot = this.idToSlot.get(terminalId);
    if (typeof slot !== "number") {
      return false;
    }
    const activeStream = this.activeStreams.get(slot);
    if (!activeStream) {
      this.idToSlot.delete(terminalId);
      return false;
    }
    activeStream.outputCoalescer.flush();
    activeStream.bufferedOutputs.length = 0;
    this.activeStreams.delete(slot);
    this.idToSlot.delete(terminalId);
    try {
      activeStream.unsubscribe();
    } catch (error) {
      this.sessionLogger.warn({ err: error }, "Failed to unsubscribe terminal stream");
    }
    if (options?.emitExit) {
      this.emit({
        type: "terminal_stream_exit",
        payload: {
          terminalId: activeStream.terminalId,
        },
      });
    }
    return true;
  }
}

function isTerminalMessage(msg: SessionInboundMessage): msg is TerminalDispatchableMessage {
  return TERMINAL_MESSAGE_TYPES.has(msg.type as TerminalDispatchableMessage["type"]);
}
