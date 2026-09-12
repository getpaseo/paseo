import type pino from "pino";
import type {
  OwnedSubscription,
  SessionDelivery,
} from "../server/session/owned-subscriptions/index.js";
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
import { killTerminalsForWorkspace as killWorkspaceTerminals } from "../server/workspace-archive-service.js";
import {
  TerminalStreamOpcode,
  decodeTerminalResizePayload,
  encodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";
import {
  MAX_CLIENT_BUFFERED_BYTES,
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
import { applyTerminalSize } from "./terminal-size-ownership.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { terminalSubscriptionKey } from "@getpaseo/protocol/terminal-subscription-key";

const MAX_TERMINAL_STREAM_SLOTS = 256;

interface TerminalDirectorySubscription {
  cwd: string;
  workspaceId: string | undefined;
  owner: OwnedSubscription;
  refresh: Promise<void> | null;
  pending: boolean;
}

interface BufferedTerminalOutput {
  data: string;
  revision?: number;
}

interface ActiveTerminalStream {
  terminalId: string;
  slot: number;
  owner: OwnedSubscription;
  snapshotTask?: Promise<void>;
  snapshotOutput?: Buffer;
  exiting: boolean;
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
  hasBinaryChannel: () => boolean;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  sessionLogger: pino.Logger;
  listTerminalWorkspaceRefs?: () => Promise<readonly TerminalWorkspaceRef[]>;
  listTerminalWorkspaceRoots?: () => Promise<readonly string[]>;
  // Whether the connected client can reflow restored snapshots. When true the
  // daemon attaches per-row soft-wrap flags to snapshots; otherwise it omits them
  // so old (strict-schema) clients still parse the snapshot.
  clientSupportsWrapReflow?: (source: object) => boolean;
  // Current max bytes queued on the client's transport(s) but not yet sent.
  // Drives the snapshot catch-up fallback: a keeping-up client reports ~0 and
  // keeps streaming; a backed-up client trips the snapshot path. Defaults to a
  // constant 0 (no backpressure signal) so callers without a transport always
  // stream.
  // Bytes queued on the client transport but not yet sent, or null when the
  // transport exposes no backpressure signal (e.g. the multiplexed relay socket).
  getClientBufferedAmount?: (source: object) => number | null;
}

interface TerminalWorkspaceRef {
  workspaceId: string;
  cwd: string;
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
  private readonly hasBinaryChannel: () => boolean;
  private readonly isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  private readonly sessionLogger: pino.Logger;
  private readonly listTerminalWorkspaceRefs: () => Promise<readonly TerminalWorkspaceRef[]>;
  private readonly listTerminalWorkspaceRoots: () => Promise<readonly string[]>;
  private readonly clientSupportsWrapReflow: (source: object) => boolean;
  private readonly getClientBufferedAmount: (source: object) => number | null;

  private readonly subscribedDirectories = new Map<string, TerminalDirectorySubscription>();
  private unsubscribeTerminalsChanged: (() => void) | null = null;
  private readonly activeStreams = new Map<number, ActiveTerminalStream>();
  private nextSlot = 0;

  constructor(options: TerminalSessionControllerOptions) {
    this.terminalManager = options.terminalManager;
    this.emit = options.emit;
    this.hasBinaryChannel = options.hasBinaryChannel;
    this.isPathWithinRoot = options.isPathWithinRoot;
    this.sessionLogger = options.sessionLogger;
    this.listTerminalWorkspaceRefs = options.listTerminalWorkspaceRefs ?? (async () => []);
    this.listTerminalWorkspaceRoots =
      options.listTerminalWorkspaceRoots ??
      (async () => (await this.listTerminalWorkspaceRefs()).map((workspace) => workspace.cwd));
    this.clientSupportsWrapReflow = options.clientSupportsWrapReflow ?? (() => false);
    this.getClientBufferedAmount = options.getClientBufferedAmount ?? (() => 0);
  }

  start(): void {
    if (!this.terminalManager || this.unsubscribeTerminalsChanged) return;
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

  async hasDirectorySubscription(
    input: { cwd: string; workspaceId?: string },
    source?: object,
  ): Promise<boolean> {
    const subscriptions = [...this.subscribedDirectories.values()].filter(
      (subscription) => !source || subscription.owner.source === source,
    );
    if (subscriptions.length === 0) return false;
    const workspaceRoots = await this.listTerminalWorkspaceRoots();
    return subscriptions.some((subscription) => {
      if (
        subscription.workspaceId !== undefined &&
        subscription.workspaceId !== input.workspaceId
      ) {
        return false;
      }
      return this.terminalBelongsToRoot(subscription.cwd, input.cwd, workspaceRoots);
    });
  }

  dispatch(msg: SessionInboundMessage, ownership: SessionDelivery): Promise<void> | undefined {
    if (!isTerminalMessage(msg)) {
      return undefined;
    }
    switch (msg.type) {
      case "subscribe_terminals_request":
        return this.handleSubscribeTerminalsRequest(msg, ownership);
      case "unsubscribe_terminals_request":
        return ownership.releaseLegacySlot(
          `terminal-directory:${terminalSubscriptionKey(msg.cwd, msg.workspaceId)}`,
        );
      case "list_terminals_request":
        return this.handleListTerminalsRequest(msg);
      case "create_terminal_request":
        return this.handleCreateTerminalRequest(msg);
      case "subscribe_terminal_request":
        return this.handleSubscribeTerminalRequest(msg, ownership);
      case "unsubscribe_terminal_request":
        return ownership.releaseLegacySlot(`terminal-output:${msg.terminalId}`);
      case "terminal_input":
        if (!ownership.currentSource) throw new Error("Terminal input requires a source");
        this.handleTerminalInput(msg, ownership.currentSource);
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

  handleBinaryFrame(frame: TerminalStreamFrame, source: object): void {
    const activeStream = this.activeStreams.get(frame.slot);
    if (!activeStream || activeStream.owner.source !== source || !this.terminalManager) {
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
        applyTerminalSize(terminal, source, resize);
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

  async killTerminalsForWorkspace(workspaceId: string): Promise<void> {
    return killWorkspaceTerminals(
      {
        detachTerminalStream: (terminalId, options) => void this.detachStream(terminalId, options),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
      },
      workspaceId,
    );
  }

  dispose(): void {
    if (this.unsubscribeTerminalsChanged) {
      this.unsubscribeTerminalsChanged();
      this.unsubscribeTerminalsChanged = null;
    }
    this.subscribedDirectories.clear();

    for (const stream of this.activeStreams.values()) {
      void stream.owner
        .release()
        .catch((error) =>
          this.sessionLogger.warn({ err: error }, "Failed to release terminal stream"),
        );
    }
  }

  private toTerminalInfo(
    terminal: Pick<TerminalSession, "id" | "name" | "workspaceId" | "getTitle" | "getActivity">,
  ): {
    id: string;
    name: string;
    workspaceId: string;
    title?: string;
    activity: TerminalActivity | null;
  } {
    const title = terminal.getTitle();
    const activity = terminal.getActivity();
    return {
      id: terminal.id,
      name: terminal.name,
      workspaceId: terminal.workspaceId,
      ...(title ? { title } : {}),
      activity,
    };
  }

  private async handleTerminalsChanged(event: TerminalsChangedEvent): Promise<void> {
    // A terminal can live in a subdirectory of a subscribed workspace root (an
    // agent can open one there). Deliver the change to every subscribed root at
    // or above the terminal's cwd, keyed by that root, carrying the full
    // aggregated list — so the client's cache replacement doesn't drop the
    // terminals that live directly at the root.
    const matchingSubscriptions = Array.from(this.subscribedDirectories.values()).filter(
      (subscription) => this.isPathWithinRoot(subscription.cwd, event.cwd),
    );
    for (const subscription of matchingSubscriptions) {
      await this.emitTerminalsSnapshotForSubscription(subscription);
    }
  }

  private async handleSubscribeTerminalsRequest(
    msg: SubscribeTerminalsRequest,
    ownership: SessionDelivery,
  ): Promise<void> {
    if (!this.terminalManager) throw new Error("Terminal manager not available");
    let subscription: TerminalDirectorySubscription | undefined;
    const owner = ownership.begin(
      "terminal-directories",
      undefined,
      async (id) => {
        this.subscribedDirectories.delete(id);
        if (this.subscribedDirectories.size === 0) {
          this.unsubscribeTerminalsChanged?.();
          this.unsubscribeTerminalsChanged = null;
        }
        await subscription?.refresh?.catch(() => undefined);
      },
      `terminal-directory:${terminalSubscriptionKey(msg.cwd, msg.workspaceId)}`,
    );
    subscription = {
      cwd: msg.cwd,
      workspaceId: msg.workspaceId,
      owner,
      refresh: null,
      pending: false,
    };
    this.subscribedDirectories.set(owner.id, subscription);
    this.start();
    try {
      await this.emitTerminalsSnapshotForSubscription(subscription, msg.requestId);
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  private emitTerminalsSnapshotForSubscription(
    subscription: TerminalDirectorySubscription,
    requestId?: string,
  ): Promise<void> {
    if (subscription.refresh) {
      subscription.pending = true;
      return subscription.refresh;
    }
    const refresh = (async () => {
      do {
        subscription.pending = false;
        const terminals = await this.getTerminalsForWorkspaceRoot(
          subscription.cwd,
          subscription.workspaceId,
        );
        if (subscription.owner.signal.aborted) return;
        subscription.owner.emit({
          type: "terminals_changed",
          payload: {
            cwd: subscription.cwd,
            workspaceId: subscription.workspaceId,
            terminals: terminals.map((terminal) => this.toTerminalInfo(terminal)),
            ...(requestId ? { requestId } : {}),
          },
        });
        requestId = undefined;
      } while (subscription.pending);
    })();
    subscription.refresh = refresh;
    const settled = () => {
      subscription.refresh = null;
    };
    void refresh.then(settled, settled);
    return refresh;
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
      let terminals: TerminalSession[];
      if (msg.workspaceId !== undefined) {
        terminals = (await this.getAllTerminalSessions()).filter(
          (terminal) => terminal.workspaceId === msg.workspaceId,
        );
      } else if (typeof msg.cwd === "string") {
        terminals = await this.getTerminalsForWorkspaceRoot(msg.cwd);
      } else {
        terminals = await this.getAllTerminalSessions();
      }
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: terminals.map((terminal) =>
            Object.assign(this.toTerminalInfo(terminal), { cwd: terminal.cwd }),
          ),
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
    return [
      ...new Map(terminalsByDirectory.flat().map((terminal) => [terminal.id, terminal])).values(),
    ];
  }

  private async getTerminalsForWorkspaceRoot(
    cwd: string,
    workspaceId?: string,
  ): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }

    const terminals = await this.terminalManager.getTerminals(cwd, { workspaceId });
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

      const workspaceId = msg.workspaceId ?? (await this.resolveLegacyTerminalWorkspaceId(msg.cwd));
      if (!workspaceId) {
        this.emit({
          type: "create_terminal_response",
          payload: {
            terminal: null,
            error: "workspaceId is required",
            requestId: msg.requestId,
          },
        });
        return;
      }

      const workspaces = await this.listTerminalWorkspaceRefs();
      if (!workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
        throw new Error(`Workspace ${workspaceId} is not active or does not exist`);
      }

      const session = await this.terminalManager.createTerminal({
        cwd: msg.cwd,
        workspaceId,
        name: msg.name,
        command: msg.command,
        args: msg.args,
        rows: msg.size?.rows,
        cols: msg.size?.cols,
      });
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            workspaceId: session.workspaceId,
            ...(session.getTitle() ? { title: session.getTitle() } : {}),
            activity: session.getActivity(),
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

  private async resolveLegacyTerminalWorkspaceId(cwd: string): Promise<string | null> {
    const workspaceRefs = await this.listTerminalWorkspaceRefs();
    if (workspaceRefs.length === 0) {
      return null;
    }

    const exactMatch = workspaceRefs.find((workspace) => this.isSamePath(workspace.cwd, cwd));
    if (exactMatch) {
      return exactMatch.workspaceId;
    }

    const ownerRoot = this.resolveTerminalOwnerRoot(
      cwd,
      workspaceRefs.map((workspace) => workspace.cwd),
    );
    if (!ownerRoot) {
      return null;
    }

    return (
      workspaceRefs.find((workspace) => this.isSamePath(workspace.cwd, ownerRoot))?.workspaceId ??
      null
    );
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

  private async handleSubscribeTerminalRequest(
    msg: SubscribeTerminalRequest,
    ownership: SessionDelivery,
  ): Promise<void> {
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

    let stream: ActiveTerminalStream | undefined;
    const owner = ownership.begin(
      "terminal-output",
      undefined,
      async () => {
        if (!stream) return;
        this.detachRegistration(stream);
        await stream.snapshotTask;
      },
      `terminal-output:${msg.terminalId}`,
    );
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09 once client floor >= v0.8.0.
    if (!ownership.isModern(owner.source) && msg.restore?.size) {
      applyTerminalSize(session, owner.source, {
        ...msg.restore.size,
        intent: "claim",
      });
    }

    const slot = this.bindActiveStream(session, owner, { restore: msg.restore });
    if (slot === null) {
      await owner.release();
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
        subscriptionId: owner.responseId,
        error: null,
        requestId: msg.requestId,
      },
    });

    stream = this.activeStreams.get(slot);
    if (stream) void this.trySendSnapshot(stream);
  }

  private handleTerminalInput(msg: TerminalInput, source: object): void {
    if (!this.terminalManager) {
      return;
    }
    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.sessionLogger.warn({ terminalId: msg.terminalId }, "Terminal not found for input");
      return;
    }

    if (msg.message.type === "resize") {
      applyTerminalSize(session, source, msg.message);
      return;
    }

    session.send(msg.message);
  }

  private killTracked(terminalId: string, options?: { emitExit: boolean }): void {
    this.detachStream(terminalId, { emitExit: options?.emitExit ?? true });
    this.terminalManager?.killTerminal(terminalId);
  }

  private async handleKillTerminalRequest(msg: KillTerminalRequest): Promise<void> {
    let success = false;
    if (this.terminalManager) {
      try {
        this.detachStream(msg.terminalId, { emitExit: true });
        await this.terminalManager.killTerminalAndWait(msg.terminalId);
        success = true;
      } catch (error) {
        this.sessionLogger.error(
          { err: error, terminalId: msg.terminalId },
          "Failed to kill terminal",
        );
      }
    }
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        success,
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
    owner: OwnedSubscription,
    options?: { restore?: TerminalRestoreOptions },
  ): number | null {
    if (!this.hasBinaryChannel()) {
      return null;
    }

    const slot = this.allocateSlot();
    if (slot === null) {
      return null;
    }

    const activeStream: ActiveTerminalStream = {
      terminalId: terminal.id,
      slot,
      owner,
      unsubscribe: () => {},
      needsSnapshot: true,
      snapshotInFlight: false,
      exiting: false,
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
          // Catch up via a snapshot only when the client is BOTH far behind in
          // produced output AND actually backed up on the wire. A client that
          // keeps draining reports ~0 buffered, so it streams continuously even
          // past the byte threshold. outputBytesSinceSnapshot keeps accumulating
          // in that case — it's harmless, it only gates the snapshot decision at
          // the instant backpressure appears, and trySendSnapshot resets it to 0.
          // A null reading means the transport exposes no backpressure signal
          // (e.g. the multiplexed relay socket); there we can't tell a slow client
          // from a fast one, so fall back unconditionally at the byte threshold to
          // keep a slow relay client from falling unboundedly behind.
          const clientBufferedAmount = this.getClientBufferedAmount(owner.source);
          if (
            !activeStream.exiting &&
            activeStream.outputBytesSinceSnapshot > MAX_TERMINAL_OUTPUT_FRAME_BYTES &&
            (clientBufferedAmount === null || clientBufferedAmount > MAX_CLIENT_BUFFERED_BYTES)
          ) {
            // The snapshot replaces this batch only after it succeeds. If the
            // terminal disappears during the read, completion still owns these bytes.
            activeStream.snapshotOutput = payload;
            activeStream.restore = resolveRestoreAfterOutputOverflow(activeStream.restore);
            activeStream.needsSnapshot = true;
            void this.trySendSnapshot(activeStream);
            return;
          }
          activeStream.owner.emitBinary(
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

    const unsubscribeOutput = terminal.subscribe(
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
    const unsubscribeExit = terminal.onExit(() =>
      this.detachStream(terminal.id, { emitExit: true }),
    );
    activeStream.unsubscribe = () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
    return slot;
  }

  private trySendSnapshot(activeStream: ActiveTerminalStream): Promise<void> {
    if (activeStream.snapshotInFlight) return activeStream.snapshotTask ?? Promise.resolve();
    const task = this.sendSnapshot(activeStream);
    activeStream.snapshotTask = task;
    return task;
  }

  private async sendSnapshot(activeStream: ActiveTerminalStream): Promise<void> {
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
      activeStream.snapshotOutput = undefined;
      this.replayTerminalOutputAfterSnapshot(activeStream, terminal, snapshotResult.replayRevision);
      activeStream.needsSnapshot = false;
      activeStream.outputBytesSinceSnapshot = 0;
    } catch (error) {
      if (this.activeStreams.get(activeStream.slot) !== activeStream) return;
      this.sessionLogger.warn(
        { err: error, terminalId: activeStream.terminalId },
        "Failed to pull terminal snapshot",
      );
      // Natural completion owns the buffered final bytes and waits for this read.
      if (activeStream.exiting) return;
      activeStream.owner.emit({
        type: "terminal_stream_exit",
        payload: {
          terminalId: activeStream.terminalId,
          error: error instanceof Error ? error.message : "Unable to read terminal snapshot",
        },
      });
      // Cleanup removes this slot/listeners synchronously, then awaits this task.
      // Awaiting release here would make the snapshot task wait for itself.
      void activeStream.owner
        .release()
        .catch((releaseError) =>
          this.sessionLogger.warn({ err: releaseError }, "Failed to release terminal stream"),
        );
    } finally {
      activeStream.snapshotInFlight = false;
    }
  }

  private async emitLegacySnapshot(
    activeStream: ActiveTerminalStream,
    terminalManager: TerminalManager,
  ): Promise<SnapshotSendResult> {
    const snapshot = await terminalManager.getTerminalState(activeStream.terminalId, {
      includeWrapFlags: this.clientSupportsWrapReflow(activeStream.owner.source),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    activeStream.owner.emitBinary(
      encodeLegacyTerminalSnapshotFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    // The snapshot frame went out-of-band; keep the replay that follows on the
    // coalescer's trailing path so it doesn't flush back-to-back with it.
    activeStream.outputCoalescer.markFlushed();
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
      includeWrapFlags: this.clientSupportsWrapReflow(activeStream.owner.source),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    activeStream.owner.emitBinary(
      encodeTerminalRestoreFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    // The restore frame went out-of-band; keep the replay that follows on the
    // coalescer's trailing path so it doesn't flush back-to-back with it.
    activeStream.outputCoalescer.markFlushed();
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
    let detached = false;
    for (const stream of this.activeStreams.values()) {
      if (stream.terminalId !== terminalId) continue;
      detached = true;
      if (stream.exiting) continue;
      stream.exiting = true;
      const completion = options?.emitExit ? this.completeStream(stream) : stream.owner.release();
      void completion.catch((error) =>
        this.sessionLogger.warn({ err: error }, "Failed to release terminal stream"),
      );
    }
    return detached;
  }

  private async completeStream(stream: ActiveTerminalStream): Promise<void> {
    // Preserve bootstrap/snapshot ordering. Explicit release can remove this
    // registration while the read is pending, in which case it discards delivery.
    await stream.snapshotTask;
    if (this.activeStreams.get(stream.slot) !== stream) return;
    if (stream.snapshotOutput) {
      stream.outputCoalescer.handle(stream.snapshotOutput.toString("utf8"));
      stream.snapshotOutput = undefined;
    }
    for (const output of stream.bufferedOutputs.splice(0)) {
      stream.outputCoalescer.handle(output.data);
    }
    // Completion must not turn this final flush into another backpressure read.
    stream.outputCoalescer.flush();
    stream.owner.emit({ type: "terminal_stream_exit", payload: { terminalId: stream.terminalId } });
    await stream.owner.release();
  }

  private detachRegistration(stream: ActiveTerminalStream): void {
    this.activeStreams.delete(stream.slot);
    stream.outputCoalescer.dispose();
    stream.snapshotOutput = undefined;
    stream.bufferedOutputs.length = 0;
    stream.unsubscribe();
  }
}

function isTerminalMessage(msg: SessionInboundMessage): msg is TerminalDispatchableMessage {
  return TERMINAL_MESSAGE_TYPES.has(msg.type as TerminalDispatchableMessage["type"]);
}
