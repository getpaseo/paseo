import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SubscribeTerminalRequest, TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalOutputData } from "./terminal-emulator-runtime";
import { i18n } from "@/i18n/i18next";

export type TerminalStreamControllerClient = Pick<
  DaemonClient,
  "observeTerminal" | "sendTerminalInput"
>;

export interface TerminalStreamControllerSize {
  rows: number;
  cols: number;
}

export interface TerminalStreamControllerStatus {
  terminalId: string | null;
  isAttaching: boolean;
  error: string | null;
}

export interface TerminalStreamControllerOptions {
  client: TerminalStreamControllerClient;
  getPreferredSize: () => TerminalStreamControllerSize | null;
  onOutput: (input: { terminalId: string; data: TerminalOutputData }) => void;
  onSnapshot: (input: { terminalId: string; state: TerminalState }) => void;
  onExit?: (terminalId: string) => void;
  onRestore?: (input: { terminalId: string; data: TerminalOutputData }) => void;
  getRestoreOptions?: () => SubscribeTerminalRequest["restore"] | undefined;
  onStatusChange?: (status: TerminalStreamControllerStatus) => void;
}

const TERMINAL_EXITED_ERROR = "Terminal exited";

export class TerminalStreamController {
  private subscription: ReturnType<DaemonClient["observeTerminal"]> | null = null;
  private terminalId: string | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalStreamControllerOptions) {}

  private receive: Parameters<DaemonClient["observeTerminal"]>[1] = (event) => {
    if (this.disposed || event.terminalId !== this.terminalId) {
      return;
    }
    if (event.type === "snapshot") {
      this.options.onSnapshot({ terminalId: event.terminalId, state: event.state });
      return;
    }
    if (event.type === "restore") {
      if (event.data.length > 0) {
        this.options.onRestore?.({ terminalId: event.terminalId, data: event.data });
      }
      return;
    }
    if (event.data.length > 0) {
      this.options.onOutput({ terminalId: event.terminalId, data: event.data });
    }
  };

  setTerminal(input: { terminalId: string | null }): void {
    if (this.disposed || input.terminalId === this.terminalId) {
      return;
    }
    const nextTerminalId = input.terminalId;
    this.terminalId = nextTerminalId;
    void this.subscription?.release().catch(console.error);
    this.subscription = null;
    if (!nextTerminalId) {
      this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
      return;
    }
    const restore = this.options.getRestoreOptions?.();
    this.options.onStatusChange?.({ terminalId: nextTerminalId, isAttaching: true, error: null });
    let subscription: ReturnType<DaemonClient["observeTerminal"]>;
    try {
      const preferredSize = restore?.size ?? this.options.getPreferredSize();
      if (preferredSize)
        this.options.client.sendTerminalInput(nextTerminalId, {
          type: "resize",
          ...preferredSize,
          intent: "claim",
        });
      subscription = this.options.client.observeTerminal(
        nextTerminalId,
        this.receive,
        restore ? { restore } : undefined,
      );
    } catch (error) {
      this.failAttach(nextTerminalId, error);
      return;
    }
    this.subscription = subscription;
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "terminal_stream_exit" || this.subscription !== subscription) return;
        if (message.payload.error)
          this.failAttach(nextTerminalId, new Error(message.payload.error));
        else this.handleTerminalExit({ terminalId: nextTerminalId });
      },
    });
    void subscription.ready
      .then((payload) => {
        if (this.disposed || this.subscription !== subscription) {
          return;
        }
        if (payload.error) {
          this.terminalId = null;
          this.options.onStatusChange?.({
            terminalId: nextTerminalId,
            isAttaching: false,
            error: payload.error,
          });
          return;
        }
        this.options.onStatusChange?.({
          terminalId: nextTerminalId,
          isAttaching: false,
          error: null,
        });
        return;
      })
      .catch((error: unknown) => {
        if (this.disposed || this.subscription !== subscription) {
          return;
        }
        this.failAttach(nextTerminalId, error);
      });
  }

  private failAttach(terminalId: string, error: unknown): void {
    this.terminalId = null;
    void this.subscription?.release().catch(console.error);
    this.subscription = null;
    this.options.onStatusChange?.({
      terminalId,
      isAttaching: false,
      error:
        error instanceof Error ? error.message : i18n.t("workspace.terminal.unableToSubscribe"),
    });
  }

  handleTerminalExit(input: { terminalId: string }): void {
    if (this.disposed || input.terminalId !== this.terminalId) {
      return;
    }
    this.options.onExit?.(input.terminalId);
    this.terminalId = null;
    void this.subscription?.release().catch(console.error);
    this.subscription = null;
    this.options.onStatusChange?.({
      terminalId: input.terminalId,
      isAttaching: false,
      error: TERMINAL_EXITED_ERROR,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.terminalId = null;
    void this.subscription?.release().catch(console.error);
    this.subscription = null;
    this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
  }
}
