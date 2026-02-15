export interface TerminalOutputBuffer {
  segments: string[];
  startIndex: number;
  totalChars: number;
}

const COMPACT_SEGMENT_THRESHOLD = 256;

export function createTerminalOutputBuffer(): TerminalOutputBuffer {
  return {
    segments: [],
    startIndex: 0,
    totalChars: 0,
  };
}

function normalizeMaxChars(input: { maxChars: number }): number {
  if (!Number.isFinite(input.maxChars)) {
    return 0;
  }
  return Math.max(0, Math.floor(input.maxChars));
}

function compactTerminalOutputBuffer(input: { buffer: TerminalOutputBuffer }): void {
  const { buffer } = input;
  if (buffer.startIndex <= COMPACT_SEGMENT_THRESHOLD) {
    return;
  }

  buffer.segments = buffer.segments.slice(buffer.startIndex);
  buffer.startIndex = 0;
}

function trimTerminalOutputBufferToMax(input: {
  buffer: TerminalOutputBuffer;
  maxChars: number;
}): void {
  const { buffer } = input;
  const maxChars = normalizeMaxChars({ maxChars: input.maxChars });

  while (buffer.totalChars > maxChars) {
    const leadingSegment = buffer.segments[buffer.startIndex];
    if (!leadingSegment) {
      buffer.segments = [];
      buffer.startIndex = 0;
      buffer.totalChars = 0;
      return;
    }

    const overflowChars = buffer.totalChars - maxChars;
    if (leadingSegment.length <= overflowChars) {
      buffer.startIndex += 1;
      buffer.totalChars -= leadingSegment.length;
      continue;
    }

    buffer.segments[buffer.startIndex] = leadingSegment.slice(overflowChars);
    buffer.totalChars -= overflowChars;
    break;
  }

  compactTerminalOutputBuffer({ buffer });
}

export function appendTerminalOutputBuffer(input: {
  buffer: TerminalOutputBuffer;
  text: string;
  maxChars: number;
}): void {
  if (!input.text) {
    return;
  }

  input.buffer.segments.push(input.text);
  input.buffer.totalChars += input.text.length;
  trimTerminalOutputBufferToMax({
    buffer: input.buffer,
    maxChars: input.maxChars,
  });
}

export function readTerminalOutputBuffer(input: {
  buffer: TerminalOutputBuffer;
}): string {
  const { buffer } = input;
  if (buffer.totalChars <= 0) {
    return "";
  }

  if (buffer.startIndex === 0) {
    return buffer.segments.join("");
  }

  return buffer.segments.slice(buffer.startIndex).join("");
}
