import type { TerminalState } from "@server/shared/messages";

export type TerminalStreamControllerClient = {
  subscribeTerminal: (terminalId: string) => Promise<{
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
        | { terminalId: string; type: "snapshot"; state: TerminalState },
    ) => void,
  ) => () => void;
};

export type TerminalStreamControllerSize = {
  rows: number;
  cols: number;
};

export type TerminalStreamControllerStatus = {
  terminalId: string | null;
  isAttaching: boolean;
  error: string | null;
};

export type TerminalStreamControllerOptions = {
  client: TerminalStreamControllerClient;
  getPreferredSize: () => TerminalStreamControllerSize | null;
  onOutput: (input: { terminalId: string; text: string }) => void;
  onSnapshot: (input: { terminalId: string; state: TerminalState }) => void;
  onStatusChange?: (status: TerminalStreamControllerStatus) => void;
};

const TERMINAL_EXITED_ERROR = "Terminal exited";

export class TerminalStreamController {
  private readonly decoder = new TextDecoder();
  private readonly unsubscribeStreamEvents: () => void;
  private terminalId: string | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalStreamControllerOptions) {
    this.unsubscribeStreamEvents = this.options.client.onTerminalStreamEvent((event) => {
      if (this.disposed || event.terminalId !== this.terminalId) {
        return;
      }
      if (event.type === "snapshot") {
        this.decoder.decode();
        this.options.onSnapshot({ terminalId: event.terminalId, state: event.state });
        return;
      }
      const text = this.decoder.decode(event.data, { stream: true });
      if (text.length > 0) {
        this.options.onOutput({ terminalId: event.terminalId, text });
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
    this.decoder.decode();
    if (previousTerminalId) {
      this.options.client.unsubscribeTerminal(previousTerminalId);
    }
    if (!nextTerminalId) {
      this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
      return;
    }
    this.options.onStatusChange?.({ terminalId: nextTerminalId, isAttaching: true, error: null });
    void this.options.client
      .subscribeTerminal(nextTerminalId)
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
    this.decoder.decode();
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
    this.decoder.decode();
    const terminalId = this.terminalId;
    this.terminalId = null;
    if (terminalId) {
      this.options.client.unsubscribeTerminal(terminalId);
    }
    this.unsubscribeStreamEvents();
    this.options.onStatusChange?.({ terminalId: null, isAttaching: false, error: null });
  }
}
