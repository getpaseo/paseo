import { describe, expect, it } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import {
  createThrottledPersistStorage,
  type PersistenceScheduler,
} from "./throttled-persist-storage";

interface TextState {
  text: string;
}

const INTERVAL_MS = 200;

function createThrottledPersistence() {
  let nowMs = 0;
  let saved: StorageValue<TextState> | null = null;
  let writes = 0;
  let scheduled: { callback: () => void; dueAt: number } | null = null;
  const storage: PersistStorage<TextState> = {
    getItem: () => saved,
    setItem: (_name, value) => {
      writes += 1;
      saved = value;
    },
    removeItem: () => {
      saved = null;
    },
  };
  const scheduler: PersistenceScheduler = {
    now: () => nowMs,
    schedule: (callback, delayMs) => (scheduled = { callback, dueAt: nowMs + delayMs }),
    cancel: () => {
      scheduled = null;
    },
  };
  const throttled = createThrottledPersistStorage(storage, { intervalMs: INTERVAL_MS, scheduler });

  return {
    save(state: TextState) {
      throttled.setItem("text", { state });
    },
    remove() {
      throttled.removeItem("text");
    },
    flush() {
      return throttled.flush();
    },
    advance(ms: number) {
      nowMs += ms;
      if (scheduled && scheduled.dueAt <= nowMs) {
        const { callback } = scheduled;
        scheduled = null;
        callback();
      }
    },
    text() {
      return saved?.state.text ?? null;
    },
    writes() {
      return writes;
    },
  };
}

describe("throttled persist storage", () => {
  it("writes the first change and the latest change in each interval", () => {
    const persistence = createThrottledPersistence();

    persistence.save({ text: "a" });
    persistence.save({ text: "ab" });
    persistence.save({ text: "abc" });
    expect(persistence.text()).toBe("a");

    persistence.advance(INTERVAL_MS - 1);
    expect(persistence.text()).toBe("a");

    persistence.advance(1);
    expect(persistence.text()).toBe("abc");
    expect(persistence.writes()).toBe(2);
  });

  it("does not restore a pending value after storage is cleared", () => {
    const persistence = createThrottledPersistence();

    persistence.save({ text: "first checkpoint" });
    persistence.save({ text: "pending checkpoint" });
    persistence.remove();
    persistence.advance(INTERVAL_MS);

    expect(persistence.text()).toBeNull();
  });

  it("continues writing the latest change across consecutive intervals", () => {
    const persistence = createThrottledPersistence();

    persistence.save({ text: "first" });
    persistence.save({ text: "first interval" });
    persistence.advance(INTERVAL_MS);
    expect(persistence.text()).toBe("first interval");

    persistence.save({ text: "second" });
    persistence.save({ text: "second interval" });
    persistence.advance(INTERVAL_MS);
    expect(persistence.text()).toBe("second interval");
  });

  it("flushes the latest pending change before the interval ends", async () => {
    const persistence = createThrottledPersistence();

    persistence.save({ text: "first checkpoint" });
    persistence.save({ text: "pending checkpoint" });
    await persistence.flush();

    expect(persistence.text()).toBe("pending checkpoint");
  });

  it("drops a value whose state is the one already accepted", () => {
    const persistence = createThrottledPersistence();
    const state = { text: "same" };

    persistence.save(state);
    persistence.advance(INTERVAL_MS);
    persistence.save(state);
    persistence.save(state);
    persistence.advance(INTERVAL_MS);

    expect(persistence.writes()).toBe(1);

    persistence.save({ text: "same" });
    expect(persistence.writes()).toBe(2);
  });

  it("writes the same state again after storage is cleared", () => {
    const persistence = createThrottledPersistence();
    const state = { text: "kept" };

    persistence.save(state);
    persistence.remove();
    persistence.advance(INTERVAL_MS);
    persistence.save(state);

    expect(persistence.text()).toBe("kept");
  });
});
