import pLimit from "p-limit";

interface ImportDescriptorCandidate {
  cacheKey: string;
}

interface PendingDescriptor<Descriptor> {
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  promise: Promise<Descriptor>;
}

export function createImportDescriptorScheduler<
  Candidate extends ImportDescriptorCandidate,
  Descriptor,
>(
  read: (candidate: Candidate, signal: AbortSignal) => Promise<Descriptor>,
): (candidates: Candidate[], signal: AbortSignal) => Promise<Descriptor[]> {
  const limit = pLimit(4);
  const reads = new Map<string, PendingDescriptor<Descriptor>>();

  function acquire(candidate: Candidate): PendingDescriptor<Descriptor> {
    let pending = reads.get(candidate.cacheKey);
    if (!pending) {
      const controller = new AbortController();
      const entry: PendingDescriptor<Descriptor> = {
        controller,
        subscribers: 0,
        settled: false,
        promise: limit(() => {
          controller.signal.throwIfAborted();
          return read(candidate, controller.signal);
        }).finally(() => {
          entry.settled = true;
          if (reads.get(candidate.cacheKey) === entry) reads.delete(candidate.cacheKey);
        }),
      };
      reads.set(candidate.cacheKey, entry);
      pending = entry;
    }
    pending.subscribers += 1;
    return pending;
  }

  function release(candidate: Candidate, pending: PendingDescriptor<Descriptor>): void {
    pending.subscribers -= 1;
    // The initiating listing has no special ownership of a shared read.
    if (pending.subscribers === 0 && !pending.settled) {
      if (reads.get(candidate.cacheKey) === pending) reads.delete(candidate.cacheKey);
      pending.controller.abort();
    }
  }

  return async (candidates, signal) => {
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const results: Descriptor[] = [];
      for (const candidate of candidates) {
        signal.throwIfAborted();
        // One outstanding read per listing gives later requests a turn in the
        // shared FIFO instead of putting hundreds of candidates ahead of them.
        const pending = acquire(candidate);
        try {
          results.push(await Promise.race([pending.promise, aborted]));
        } finally {
          release(candidate, pending);
        }
      }
      return results;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}
