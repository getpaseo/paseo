export const MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const MAX_WORKTREE_SETUP_TOTAL_OUTPUT_BYTES = 256 * 1024;

export interface WorktreeSetupOutputAccumulator {
  readonly maxBytes: number;
  totalBytes: number;
  head: Buffer;
  tail: Buffer;
  truncated: boolean;
}

export interface RenderedWorktreeSetupOutput {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

export function getWorktreeSetupCommandOutputLimit(totalCommands: number): number {
  const commandCount = Math.max(1, Math.floor(totalCommands));
  return Math.min(
    MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES,
    Math.floor(MAX_WORKTREE_SETUP_TOTAL_OUTPUT_BYTES / commandCount),
  );
}

export function createWorktreeSetupOutputAccumulator(
  maxBytes: number,
): WorktreeSetupOutputAccumulator {
  return {
    maxBytes: Math.max(0, Math.floor(maxBytes)),
    totalBytes: 0,
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    truncated: false,
  };
}

export function appendWorktreeSetupOutput(
  accumulator: WorktreeSetupOutputAccumulator,
  chunk: string,
): void {
  if (!chunk) {
    return;
  }

  const chunkBytes = Buffer.from(chunk, "utf8");
  accumulator.totalBytes += chunkBytes.length;

  if (accumulator.maxBytes === 0) {
    accumulator.truncated = true;
    return;
  }

  const headCapacity = Math.floor(accumulator.maxBytes / 2);
  const tailCapacity = accumulator.maxBytes - headCapacity;
  if (!accumulator.truncated) {
    const combined = Buffer.concat([accumulator.head, chunkBytes]);
    if (combined.length <= accumulator.maxBytes) {
      accumulator.head = combined;
      return;
    }
    accumulator.head = combined.subarray(0, headCapacity);
    accumulator.tail = combined.subarray(combined.length - tailCapacity);
    accumulator.truncated = true;
    return;
  }

  const combinedTail = Buffer.concat([accumulator.tail, chunkBytes]);
  accumulator.tail = combinedTail.subarray(Math.max(0, combinedTail.length - tailCapacity));
}

export function renderWorktreeSetupOutput(
  accumulator: WorktreeSetupOutputAccumulator,
  maxBytes: number = accumulator.maxBytes,
): RenderedWorktreeSetupOutput {
  const outputLimit = Math.max(0, Math.min(accumulator.maxBytes, Math.floor(maxBytes)));
  if (!accumulator.truncated && accumulator.totalBytes <= outputLimit) {
    return {
      text: accumulator.head.toString("utf8"),
      truncated: false,
      omittedBytes: 0,
    };
  }

  let retainedBytes = Math.min(accumulator.totalBytes, outputLimit);
  let omittedBytes = accumulator.totalBytes - retainedBytes;
  for (;;) {
    const markerBytes = Buffer.byteLength(buildOmissionMarker(omittedBytes), "utf8");
    const nextRetainedBytes = Math.min(
      accumulator.totalBytes,
      Math.max(0, outputLimit - markerBytes),
    );
    const nextOmittedBytes = accumulator.totalBytes - nextRetainedBytes;
    if (nextRetainedBytes === retainedBytes && nextOmittedBytes === omittedBytes) {
      break;
    }
    retainedBytes = nextRetainedBytes;
    omittedBytes = nextOmittedBytes;
  }

  const headBytes = Math.floor(retainedBytes / 2);
  const tailBytes = retainedBytes - headBytes;
  const head = accumulator.head.subarray(0, headBytes);
  const tailSource = accumulator.truncated ? accumulator.tail : accumulator.head;
  const tail = tailSource.subarray(Math.max(0, tailSource.length - tailBytes));
  omittedBytes = accumulator.totalBytes - head.length - tail.length;

  return {
    text: `${head.toString("utf8")}${buildOmissionMarker(omittedBytes)}${tail.toString("utf8")}`,
    truncated: true,
    omittedBytes,
  };
}

function buildOmissionMarker(omittedBytes: number): string {
  const unit = omittedBytes === 1 ? "byte" : "bytes";
  return `\n...<${omittedBytes} ${unit} omitted>...\n`;
}
