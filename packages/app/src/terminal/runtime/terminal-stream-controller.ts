import type { SubscribeTerminalRequest, TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalOutputData } from "./terminal-emulator-runtime";

export interface TerminalStreamControllerClient {
  subscribeTerminal: (
    terminalId: string,
    options?: { restore?: SubscribeTerminalRequest["restore"] },
  ) => Promise<{
    terminalId: string;
    error?: string | null;
  }>;
  unsubscribeTerminal: (terminalId: string) => void;
  sendTerminalInput: (
    terminalId: string,
    message: { type: "resize"; rows: number; cols: number },
  ) => void;
  onTerminalStreamEvent: (
    handler: (
      event:
        | { terminalId: string; type: "output"; data: Uint8Array }
        | { terminalId: string; type: "snapshot"; state: TerminalState }
        | { terminalId: string; type: "restore"; data: Uint8Array },
    ) => void,
  ) => () => void;
}

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
  onRestore?: (input: { terminalId: string; data: TerminalOutputData }) => void;
  getRestoreOptions?: () => SubscribeTerminalRequest["restore"] | undefined;
  onStatusChange?: (status: TerminalStreamControllerStatus) => void;
}

const TERMINAL_EXITED_ERROR = "Terminal exited";

export class TerminalStreamController {
  private readonly unsubscribeStreamEvents: () => void;
  private terminalId: string | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalStreamControllerOptions) {
    this.unsubscribeStreamEvents = this.options.client.onTerminalStreamEvent((event) => {
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
    });
  }

  setTerminal(input: { terminalId: string | null }): void {
    if (this.disposed || input.terminalId === this.terminalId) {
      return;
    }
    const nextTerminalId = input.terminalId;
    const previousTerminalId = this.terminalId;
    this.terminalId = nextTerminalId;
    if (previousTerminalId) {
      this.options.client.unsubscribeTerminal(previousTerminalId);
    }
    if (!nextTerminalId) {
      this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
      return;
    }
    const restore = this.options.getRestoreOptions?.();
    this.options.onStatusChange?.({ terminalId: nextTerminalId, isAttaching: true, error: null });
    void this.options.client
      .subscribeTerminal(nextTerminalId, restore ? { restore } : undefined)
      .then((payload) => {
        if (this.disposed || this.terminalId !== nextTerminalId) {
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
        const preferredSize = this.options.getPreferredSize();
        if (preferredSize) {
          this.options.client.sendTerminalInput(nextTerminalId, {
            type: "resize",
            rows: preferredSize.rows,
            cols: preferredSize.cols,
          });
        }
        this.options.onStatusChange?.({
          terminalId: nextTerminalId,
          isAttaching: false,
          error: null,
        });
        return;
      })
      .catch((error: unknown) => {
        if (this.disposed || this.terminalId !== nextTerminalId) {
          return;
        }
        this.terminalId = null;
        this.options.onStatusChange?.({
          terminalId: nextTerminalId,
          isAttaching: false,
          error: error instanceof Error ? error.message : "Unable to subscribe to terminal",
        });
      });
  }

  handleTerminalExit(input: { terminalId: string }): void {
    if (this.disposed || input.terminalId !== this.terminalId) {
      return;
    }
    this.terminalId = null;
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
    const terminalId = this.terminalId;
    this.terminalId = null;
    if (terminalId) {
      this.options.client.unsubscribeTerminal(terminalId);
    }
    this.unsubscribeStreamEvents();
    this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
  }
}
