import {
  getTerminalAttachRetryDelayMs,
  getTerminalResumeOffset,
  isTerminalAttachRetryableError,
  updateTerminalResumeOffset,
  waitForDuration,
  withPromiseTimeout,
} from "@/utils/terminal-attach";
import { summarizeTerminalText, terminalDebugLog } from "./terminal-debug";

export type TerminalStreamControllerAttachPayload = {
  streamId: number | null;
  replayedFrom?: number;
  currentOffset: number;
  reset: boolean;
  error?: string | null;
};

export type TerminalStreamControllerChunk = {
  offset: number;
  endOffset: number;
  replay?: boolean;
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
  nextExpectedOffset: number | null;
  catchUpEndOffset: number | null;
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
    terminalDebugLog({
      scope: "stream-controller",
      event: "terminal:set",
      details: {
        previousTerminalId: this.selectedTerminalId,
        nextTerminalId: input.terminalId,
      },
    });

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
    terminalDebugLog({
      scope: "stream-controller",
      event: "stream:exit",
      details: {
        terminalId: input.terminalId,
        streamId: input.streamId,
      },
    });

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
      terminalDebugLog({
        scope: "stream-controller",
        event: "attach:attempt",
        details: {
          terminalId: input.terminalId,
          generation: input.generation,
          attempt,
          maxAttachAttempts,
        },
      });

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
          terminalDebugLog({
            scope: "stream-controller",
            event: "attach:response-error",
            details: {
              terminalId: input.terminalId,
              attempt,
              error: lastErrorMessage,
            },
          });
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
        const replayedFromOffset =
          typeof attachPayload.replayedFrom === "number"
            ? Math.max(0, Math.floor(attachPayload.replayedFrom))
            : null;
        const currentOffset = Math.max(
          0,
          Math.floor(attachPayload.currentOffset)
        );
        const shouldResetForReplayBootstrap =
          typeof resumeOffset !== "number" &&
          typeof replayedFromOffset === "number" &&
          replayedFromOffset < currentOffset;
        if (shouldResetForReplayBootstrap) {
          this.options.onReset?.({ terminalId: input.terminalId });
        }
        const startExpectedOffset =
          replayedFromOffset ??
          (typeof resumeOffset === "number"
            ? Math.max(0, Math.floor(resumeOffset))
            : currentOffset);
        const catchUpEndOffset = currentOffset;

        const activeStream: TerminalStreamControllerActiveStream = {
          terminalId: input.terminalId,
          streamId,
          decoder,
          nextExpectedOffset: startExpectedOffset,
          catchUpEndOffset,
          unsubscribe: () => {},
        };
        this.activeStream = activeStream;
        const unsubscribe = this.options.client.onTerminalStreamData(streamId, (chunk) => {
          this.handleChunk({
            terminalId: input.terminalId,
            streamId,
            chunk,
            decoder,
          });
        });
        if (this.activeStream === activeStream) {
          activeStream.unsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
        terminalDebugLog({
          scope: "stream-controller",
          event: "attach:success",
          details: {
            terminalId: input.terminalId,
            streamId,
            replayedFrom: attachPayload.replayedFrom ?? null,
            requestedResumeOffset: resumeOffset ?? null,
            currentOffset: attachPayload.currentOffset,
            reset: attachPayload.reset,
            bootstrapReset: shouldResetForReplayBootstrap,
          },
        });
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
        terminalDebugLog({
          scope: "stream-controller",
          event: "attach:exception",
          details: {
            terminalId: input.terminalId,
            attempt,
            error: lastErrorMessage,
          },
        });
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

    const chunkOffset = Number.isFinite(input.chunk.offset)
      ? Math.max(0, Math.floor(input.chunk.offset))
      : 0;
    const chunkEndOffset = Number.isFinite(input.chunk.endOffset)
      ? Math.max(0, Math.floor(input.chunk.endOffset))
      : chunkOffset;
    if (chunkEndOffset < chunkOffset) {
      return;
    }

    const expectedOffset = activeStream.nextExpectedOffset;
    if (typeof expectedOffset === "number") {
      if (chunkEndOffset <= expectedOffset) {
        return;
      }
      if (chunkOffset !== expectedOffset) {
        const catchUpEndOffset = activeStream.catchUpEndOffset;
        const canSkipReplayGap =
          chunkOffset > expectedOffset &&
          typeof catchUpEndOffset === "number" &&
          expectedOffset < catchUpEndOffset &&
          chunkOffset <= catchUpEndOffset;

        if (canSkipReplayGap) {
          activeStream.nextExpectedOffset = chunkOffset;
        } else {
          this.recoverFromStreamGap({
            terminalId: input.terminalId,
            streamId: input.streamId,
            expectedOffset,
            observedOffset: chunkOffset,
          });
          return;
        }
      }
    }

    if (
      typeof activeStream.catchUpEndOffset === "number" &&
      chunkEndOffset >= activeStream.catchUpEndOffset
    ) {
      activeStream.catchUpEndOffset = null;
    }

    activeStream.nextExpectedOffset = chunkEndOffset;
    updateTerminalResumeOffset({
      terminalId: input.terminalId,
      offset: chunkEndOffset,
      resumeOffsetByTerminalId: this.resumeOffsetByTerminalId,
    });

    const text = input.decoder.decode(input.chunk.data, { stream: true });
    if (text.length === 0) {
      return;
    }
    terminalDebugLog({
      scope: "stream-controller",
      event: "stream:chunk",
      details: {
        terminalId: input.terminalId,
        streamId: input.streamId,
        offset: chunkOffset,
        endOffset: chunkEndOffset,
        replay: Boolean(input.chunk.replay),
        byteLength: input.chunk.data.byteLength,
        textLength: text.length,
        preview: summarizeTerminalText({ text, maxChars: 96 }),
      },
    });

    this.options.onChunk({
      terminalId: input.terminalId,
      text,
    });
  }

  private recoverFromStreamGap(input: {
    terminalId: string;
    streamId: number;
    expectedOffset: number;
    observedOffset: number;
  }): void {
    const activeStream = this.activeStream;
    if (!activeStream) {
      return;
    }
    if (activeStream.streamId !== input.streamId || activeStream.terminalId !== input.terminalId) {
      return;
    }
    if (this.selectedTerminalId !== input.terminalId) {
      return;
    }

    updateTerminalResumeOffset({
      terminalId: input.terminalId,
      offset: input.expectedOffset,
      resumeOffsetByTerminalId: this.resumeOffsetByTerminalId,
    });

    this.attachGeneration += 1;
    const generation = this.attachGeneration;

    void this.detachActiveStream({ shouldDetach: true });
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

  private async detachActiveStream(input: { shouldDetach: boolean }): Promise<void> {
    const activeStream = this.activeStream;
    if (!activeStream) {
      return;
    }
    terminalDebugLog({
      scope: "stream-controller",
      event: "stream:detach",
      details: {
        terminalId: activeStream.terminalId,
        streamId: activeStream.streamId,
        shouldDetach: input.shouldDetach,
      },
    });
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
    terminalDebugLog({
      scope: "stream-controller",
      event: "status:update",
      details: {
        terminalId: status.terminalId,
        streamId: status.streamId,
        isAttaching: status.isAttaching,
        error: status.error,
      },
    });
    this.options.onStatusChange?.(status);
  }
}
