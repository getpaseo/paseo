import {
  appendTerminalOutputBuffer,
  createTerminalOutputBuffer,
  readTerminalOutputBuffer,
  type TerminalOutputBuffer,
} from "@/utils/terminal-output-buffer";

export type TerminalOutputChunk = {
  sequence: number;
  text: string;
};

export type TerminalOutputPumpOptions = {
  maxOutputChars: number;
  onSelectedOutputChunk: (chunk: TerminalOutputChunk) => void;
};

export type TerminalOutputPumpSetSelectedInput = {
  terminalId: string | null;
};

export type TerminalOutputPumpAppendInput = {
  terminalId: string;
  text: string;
};

export type TerminalOutputPumpReadInput = {
  terminalId: string | null;
};

export type TerminalOutputPumpClearInput = {
  terminalId: string;
};

export type TerminalOutputPumpPruneInput = {
  terminalIds: string[];
};

export class TerminalOutputPump {
  private readonly buffersByTerminalId = new Map<string, TerminalOutputBuffer>();
  private selectedTerminalId: string | null = null;
  private selectedChunkSequence = 0;
  private selectedChunkAccumulator = "";
  private selectedChunkFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TerminalOutputPumpOptions) {}

  setSelectedTerminal(input: TerminalOutputPumpSetSelectedInput): void {
    if (this.selectedTerminalId === input.terminalId) {
      return;
    }

    this.clearSelectedChunkFlushTimer();
    this.selectedChunkAccumulator = "";
    this.selectedTerminalId = input.terminalId;
  }

  append(input: TerminalOutputPumpAppendInput): void {
    if (input.text.length === 0) {
      return;
    }

    let buffer = this.buffersByTerminalId.get(input.terminalId);
    if (!buffer) {
      buffer = createTerminalOutputBuffer();
      this.buffersByTerminalId.set(input.terminalId, buffer);
    }

    appendTerminalOutputBuffer({
      buffer,
      text: input.text,
      maxChars: this.options.maxOutputChars,
    });

    if (this.selectedTerminalId !== input.terminalId) {
      return;
    }

    this.selectedChunkAccumulator += input.text;
    this.scheduleSelectedChunkFlush();
  }

  clearTerminal(input: TerminalOutputPumpClearInput): void {
    this.buffersByTerminalId.delete(input.terminalId);
    if (this.selectedTerminalId === input.terminalId) {
      this.clearSelectedChunkFlushTimer();
      this.selectedChunkAccumulator = "";
      this.emitSelectedChunk({ text: "" });
    }
  }

  prune(input: TerminalOutputPumpPruneInput): void {
    const terminalIdSet = new Set(input.terminalIds);
    for (const terminalId of Array.from(this.buffersByTerminalId.keys())) {
      if (!terminalIdSet.has(terminalId)) {
        this.buffersByTerminalId.delete(terminalId);
      }
    }
  }

  readSnapshot(input: TerminalOutputPumpReadInput): string {
    if (!input.terminalId) {
      return "";
    }
    const buffer = this.buffersByTerminalId.get(input.terminalId);
    if (!buffer) {
      return "";
    }
    return readTerminalOutputBuffer({ buffer });
  }

  dispose(): void {
    this.clearSelectedChunkFlushTimer();
    this.selectedChunkAccumulator = "";
    this.selectedTerminalId = null;
    this.buffersByTerminalId.clear();
  }

  private scheduleSelectedChunkFlush(): void {
    if (this.selectedChunkFlushTimer) {
      return;
    }

    this.selectedChunkFlushTimer = setTimeout(() => {
      this.selectedChunkFlushTimer = null;
      this.flushSelectedChunkAccumulator();
    }, 0);
  }

  private flushSelectedChunkAccumulator(): void {
    if (this.selectedChunkAccumulator.length === 0) {
      return;
    }

    const text = this.selectedChunkAccumulator;
    this.selectedChunkAccumulator = "";
    this.emitSelectedChunk({ text });
  }

  private emitSelectedChunk(input: { text: string }): void {
    this.selectedChunkSequence += 1;
    this.options.onSelectedOutputChunk({
      sequence: this.selectedChunkSequence,
      text: input.text,
    });
  }

  private clearSelectedChunkFlushTimer(): void {
    if (!this.selectedChunkFlushTimer) {
      return;
    }
    clearTimeout(this.selectedChunkFlushTimer);
    this.selectedChunkFlushTimer = null;
  }
}
