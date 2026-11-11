import type { PluginTimelineExpectationStorage } from "./timeline-paint-storage";

export interface TestPluginTimelineExpectationStorage extends PluginTimelineExpectationStorage {
  raw: string | null;
  /** Makes the next read wait until `releaseRead` chooses what the stored value is. */
  holdRead(): void;
  releaseRead(raw: string | null): void;
}

export function createTestPluginTimelineExpectationStorage(
  initialRaw: string | null = null,
): TestPluginTimelineExpectationStorage {
  let raw = initialRaw;
  let pendingRead: Promise<string | null> | null = null;
  let release: ((value: string | null) => void) | null = null;

  return {
    get raw() {
      return raw;
    },
    set raw(value) {
      raw = value;
    },
    holdRead() {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      pendingRead = promise;
      release = resolve;
    },
    releaseRead(value) {
      if (!release) throw new Error("holdRead() must run before releaseRead()");
      raw = value;
      release(value);
      release = null;
      pendingRead = null;
    },
    read() {
      return pendingRead ?? Promise.resolve(raw);
    },
    async write(value) {
      raw = value;
    },
  };
}
