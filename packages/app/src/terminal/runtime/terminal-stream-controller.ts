import {
  getTerminalAttachRetryDelayMs,
  getTerminalResumeOffset,
  isTerminalAttachRetryableError,
  updateTerminalResumeOffset,
  waitForDuration,
  withPromiseTimeout,
} from "@/utils/terminal-attach";

export type TerminalStreamControllerAttachPayload = {
  streamId: number | null;
  currentOffset: number;
  reset: boolean;
  error?: string | null;
};

export type TerminalStreamControllerChunk = {
  endOffset: number;
  data: Uint8Array;
};

export type TerminalStreamControllerClient = {
  attachTerminalStream: (
    terminalId: string,
    options?: {
      resumeOffset?: number;
      rows?: number;
      cols?: number;
    }
  ) => Promise<TerminalStreamControllerAttachPayload>;
  detachTerminalStream: (streamId: number) => Promise<unknown>;
  onTerminalStreamData: (
    streamId: number,
    handler: (chunk: TerminalStreamControllerChunk) => void
  ) => () => void;
};

export type TerminalStreamControllerSize = {
  rows: number;
  cols: number;
};

export type TerminalStreamControllerStatus = {
  terminalId: string | null;
  streamId: number | null;
  isAttaching: boolean;
  error: string | null;
};

export type TerminalStreamControllerOptions = {
  client: TerminalStreamControllerClient;
  getPreferredSize: () => TerminalStreamControllerSize | null;
  onChunk: (input: { terminalId: string; text: string }) => void;
  onReset?: (input: { terminalId: string }) => void;
  onStatusChange?: (status: TerminalStreamControllerStatus) => void;
  maxAttachAttempts?: number;
  attachTimeoutMs?: number;
  reconnectErrorMessage?: string;
  withTimeout?: <T>(input: {
    promise: Promise<T>;
    timeoutMs: number;
    timeoutMessage: string;
  }) => Promise<T>;
  waitForDelay?: (input: { durationMs: number }) => Promise<void>;
  isRetryableError?: (input: { message: string }) => boolean;
  getRetryDelayMs?: (input: { attempt: number }) => number;
};

type TerminalStreamControllerActiveStream = {
  terminalId: string;
  streamId: number;
  decoder: TextDecoder;
  unsubscribe: () => void;
};

const DEFAULT_ATTACH_MAX_ATTEMPTS = 4;
const DEFAULT_ATTACH_TIMEOUT_MS = 12_000;
const DEFAULT_RECONNECT_ERROR_MESSAGE = "Terminal stream ended. Reconnecting…";

export class TerminalStreamController {
  private readonly resumeOffsetByTerminalId = new Map<string, number>();
  private selectedTerminalId: string | null = null;
  private activeStream: TerminalStreamControllerActiveStream | null = null;
  private attachGeneration = 0;
  private isDisposed = false;
  private status: TerminalStreamControllerStatus = {
    terminalId: null,
    streamId: null,
    isAttaching: false,
    error: null,
  };

  constructor(private readonly options: TerminalStreamControllerOptions) {}

  getActiveStreamId(): number | null {
    return this.activeStream?.streamId ?? null;
  }

  setTerminal(input: { terminalId: string | null }): void {
    if (this.isDisposed) {
      return;
    }

    const nextTerminalId = input.terminalId;
    const previousTerminalId = this.selectedTerminalId;
    const isSameTerminal = previousTerminalId === nextTerminalId;
    const hasActiveStreamForSelection =
      isSameTerminal &&
      this.activeStream?.terminalId === nextTerminalId &&
      typeof this.activeStream.streamId === "number";
    if (hasActiveStreamForSelection) {
      return;
    }

    this.selectedTerminalId = nextTerminalId;
    this.attachGeneration += 1;
    const generation = this.attachGeneration;

    void this.detachActiveStream({ shouldDetach: true });

    if (!nextTerminalId) {
      this.updateStatus({
        terminalId: null,
        streamId: null,
        isAttaching: false,
        error: null,
      });
      return;
    }

    this.updateStatus({
      terminalId: nextTerminalId,
      streamId: null,
      isAttaching: true,
      error: null,
    });
    void this.attachTerminal({
      terminalId: nextTerminalId,
      generation,
    });
  }

  handleStreamExit(input: { terminalId: string; streamId: number }): void {
    if (this.isDisposed) {
      return;
    }

    const activeStream = this.activeStream;
    if (!activeStream) {
      return;
    }
    if (activeStream.terminalId !== input.terminalId || activeStream.streamId !== input.streamId) {
      return;
    }
    if (this.selectedTerminalId !== input.terminalId) {
      return;
    }

    this.attachGeneration += 1;
    const generation = this.attachGeneration;
    void this.detachActiveStream({ shouldDetach: false });
    this.updateStatus({
      terminalId: input.terminalId,
      streamId: null,
      isAttaching: true,
      error:
        this.options.reconnectErrorMessage ?? DEFAULT_RECONNECT_ERROR_MESSAGE,
    });
    void this.attachTerminal({
      terminalId: input.terminalId,
      generation,
    });
  }

  pruneResumeOffsets(input: { terminalIds: string[] }): void {
    const terminalIdSet = new Set(input.terminalIds);
    for (const terminalId of Array.from(this.resumeOffsetByTerminalId.keys())) {
      if (!terminalIdSet.has(terminalId)) {
        this.resumeOffsetByTerminalId.delete(terminalId);
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.attachGeneration += 1;
    this.selectedTerminalId = null;
    void this.detachActiveStream({ shouldDetach: true });
    this.resumeOffsetByTerminalId.clear();
    this.updateStatus({
      terminalId: null,
      streamId: null,
      isAttaching: false,
      error: null,
    });
  }

  private async attachTerminal(input: {
    terminalId: string;
    generation: number;
  }): Promise<void> {
    const {
      maxAttachAttempts = DEFAULT_ATTACH_MAX_ATTEMPTS,
      attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
      withTimeout = withPromiseTimeout,
      waitForDelay = waitForDuration,
      isRetryableError = isTerminalAttachRetryableError,
      getRetryDelayMs = getTerminalAttachRetryDelayMs,
    } = this.options;

    let lastErrorMessage = "Unable to attach terminal stream";

    for (let attempt = 0; attempt < maxAttachAttempts; attempt += 1) {
      if (!this.isAttachGenerationCurrent({ generation: input.generation, terminalId: input.terminalId })) {
        return;
      }

      try {
        const preferredSize = this.options.getPreferredSize();
        const resumeOffset = getTerminalResumeOffset({
          terminalId: input.terminalId,
          resumeOffsetByTerminalId: this.resumeOffsetByTerminalId,
        });
        const attachPayload = await withTimeout({
          promise: this.options.client.attachTerminalStream(input.terminalId, {
            ...(resumeOffset !== undefined ? { resumeOffset } : {}),
            ...(preferredSize
              ? { rows: preferredSize.rows, cols: preferredSize.cols }
              : {}),
          }),
          timeoutMs: attachTimeoutMs,
          timeoutMessage: "Timed out attaching terminal stream",
        });

        if (!this.isAttachGenerationCurrent({ generation: input.generation, terminalId: input.terminalId })) {
          if (typeof attachPayload.streamId === "number") {
            void this.options.client.detachTerminalStream(attachPayload.streamId).catch(() => {});
          }
          return;
        }

        if (attachPayload.error || typeof attachPayload.streamId !== "number") {
          lastErrorMessage = attachPayload.error ?? "Unable to attach terminal stream";
          const hasRemainingAttempts = attempt < maxAttachAttempts - 1;
          if (hasRemainingAttempts && isRetryableError({ message: lastErrorMessage })) {
            await waitForDelay({ durationMs: getRetryDelayMs({ attempt }) });
            continue;
          }

          this.updateStatus({
            terminalId: input.terminalId,
            streamId: null,
            isAttaching: false,
            error: lastErrorMessage,
          });
          return;
        }

        if (attachPayload.reset) {
          this.resumeOffsetByTerminalId.delete(input.terminalId);
          this.options.onReset?.({ terminalId: input.terminalId });
        }

        updateTerminalResumeOffset({
          terminalId: input.terminalId,
          offset: attachPayload.currentOffset,
          resumeOffsetByTerminalId: this.resumeOffsetByTerminalId,
        });

        const decoder = new TextDecoder();
        const streamId = attachPayload.streamId;
        const unsubscribe = this.options.client.onTerminalStreamData(streamId, (chunk) => {
          this.handleChunk({
            terminalId: input.terminalId,
            streamId,
            chunk,
            decoder,
          });
        });

        this.activeStream = {
          terminalId: input.terminalId,
          streamId,
          decoder,
          unsubscribe,
        };
        this.updateStatus({
          terminalId: input.terminalId,
          streamId,
          isAttaching: false,
          error: null,
        });
        return;
      } catch (error) {
        lastErrorMessage =
          error instanceof Error ? error.message : "Unable to attach terminal stream";
        const hasRemainingAttempts = attempt < maxAttachAttempts - 1;
        if (hasRemainingAttempts && isRetryableError({ message: lastErrorMessage })) {
          await waitForDelay({ durationMs: getRetryDelayMs({ attempt }) });
          continue;
        }

        this.updateStatus({
          terminalId: input.terminalId,
          streamId: null,
          isAttaching: false,
          error: lastErrorMessage,
        });
        return;
      }
    }

    this.updateStatus({
      terminalId: input.terminalId,
      streamId: null,
      isAttaching: false,
      error: lastErrorMessage,
    });
  }

  private handleChunk(input: {
    terminalId: string;
    streamId: number;
    chunk: TerminalStreamControllerChunk;
    decoder: TextDecoder;
  }): void {
    const activeStream = this.activeStream;
    if (!activeStream) {
      return;
    }
    if (activeStream.streamId !== input.streamId || activeStream.terminalId !== input.terminalId) {
      return;
    }

    updateTerminalResumeOffset({
      terminalId: input.terminalId,
      offset: input.chunk.endOffset,
      resumeOffsetByTerminalId: this.resumeOffsetByTerminalId,
    });

    const text = input.decoder.decode(input.chunk.data, { stream: true });
    if (text.length === 0) {
      return;
    }

    this.options.onChunk({
      terminalId: input.terminalId,
      text,
    });
  }

  private async detachActiveStream(input: { shouldDetach: boolean }): Promise<void> {
    const activeStream = this.activeStream;
    if (!activeStream) {
      return;
    }
    this.activeStream = null;

    try {
      const tail = activeStream.decoder.decode();
      if (tail.length > 0) {
        this.options.onChunk({
          terminalId: activeStream.terminalId,
          text: tail,
        });
      }
    } catch {
      // no-op
    }

    try {
      activeStream.unsubscribe();
    } catch {
      // no-op
    }

    if (!input.shouldDetach) {
      return;
    }

    try {
      await this.options.client.detachTerminalStream(activeStream.streamId);
    } catch {
      // no-op
    }
  }

  private isAttachGenerationCurrent(input: {
    generation: number;
    terminalId: string;
  }): boolean {
    if (this.isDisposed) {
      return false;
    }
    return (
      this.attachGeneration === input.generation &&
      this.selectedTerminalId === input.terminalId
    );
  }

  private updateStatus(status: TerminalStreamControllerStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}

