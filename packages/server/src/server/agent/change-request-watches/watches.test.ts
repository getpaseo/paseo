import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { createChangeRequestWatches } from "./index.js";
import { AgentBackgroundWorkStore } from "../background-work/index.js";
import { createAgentMessageDelivery, parseAgentMessages } from "../agent-messages/index.js";
import type {
  ChangeRequestSnapshot,
  ChangeRequestSource,
} from "../../../services/change-request-source.js";

const url = "https://github.com/owner/repo/pull/42";
const reviewUrl = url + "#pullrequestreview-1";
const initial: ChangeRequestSnapshot = {
  state: "open",
  headSha: "aaa",
  checksState: "pending",
  checks: [],
  reviewDecision: null,
  activity: [],
};

afterEach(() => vi.useRealTimers());

async function createTestHome() {
  const artifacts = join(import.meta.dirname, "../../../../../../.artifacts");
  await mkdir(artifacts, { recursive: true });
  return mkdtemp(join(artifacts, "pr-watches-"));
}

function createHarness(
  home: string,
  { isActive = async (_id: string) => true, observationFails = false } = {},
) {
  const observations = new Map<string, Parameters<ChangeRequestSource["observe"]>[1]>();
  const backgroundWork = new AgentBackgroundWorkStore();
  const busy = new Set<string>();
  const turns: { recipientId: string; prompt: string }[] = [];
  const listeners = new Set<(id: string) => void>();
  const messages = createAgentMessageDelivery({
    isRunning: (id) => busy.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispatch(request) {
      turns.push({ recipientId: request.recipientId, prompt: String(request.prompt) });
      return "turn_started";
    },
    onError(error) {
      throw error;
    },
  });
  const watches = createChangeRequestWatches({
    source: {
      resolve: (input) => input,
      describe: () => "owner/repo #42",
      observe(address, callbacks) {
        observations.set(address, callbacks);
        queueMicrotask(() => {
          if (observationFails) callbacks.error(new Error("Forge unavailable"));
          else void callbacks.snapshot(initial);
        });
        return () => observations.delete(address);
      },
    },
    paseoHome: home,
    logger: pino({ enabled: false }),
    isActive,
    messages: () => messages,
    backgroundWork,
  });
  return {
    observations,
    turns,
    busy,
    messages,
    watches,
    backgroundWork,
    idle(id: string) {
      busy.delete(id);
      for (const listener of listeners) listener(id);
    },
    async close() {
      await watches.close();
      await messages.close();
    },
  };
}

test("lists and stops each agent's subscription through the background work registry", async () => {
  const home = await createTestHome();
  const h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("first", url);
    await h.watches.subscribe("second", url);
    const [first] = h.backgroundWork.list("first");
    const [second] = h.backgroundWork.list("second");
    expect(first).toMatchObject({
      description: "owner/repo #42",
      kind: "monitor",
      canStop: true,
    });
    expect(second).toMatchObject({ id: first.id, description: first.description });
    expect(h.backgroundWork.summary("first")).toEqual({ count: 1 });
    expect(h.backgroundWork.summary("second")).toEqual({ count: 1 });

    await h.watches.subscribe("first", url);
    await h.observations.get(url)!.snapshot(initial);
    expect(h.backgroundWork.list("first")).toEqual([first]);
    expect(h.observations.size).toBe(1);

    // Stop passes registry authorization before the watch mutation lane catches up.
    const unsubscribe = h.watches.unsubscribe("first", url);
    const resubscribe = h.watches.subscribe("first", url);
    const staleStop = h.backgroundWork.stopDaemon("first", first.id, first.stopToken!);
    await expect(staleStop).rejects.toThrow("Background work is no longer available to stop");
    await expect(unsubscribe).resolves.toMatchObject({ removed: true });
    await expect(resubscribe).resolves.toMatchObject({ subscribed: true });
    const [replacement] = h.backgroundWork.list("first");
    expect(replacement.stopToken).not.toBe(first.stopToken);
    await h.backgroundWork.stopDaemon("first", replacement.id, replacement.stopToken!);
    expect(h.backgroundWork.summary("first")).toBeUndefined();
    expect(h.backgroundWork.list("second")).toEqual([second]);
    expect(h.observations.size).toBe(1);
    await h.watches.unsubscribe("second", url);
    expect(h.backgroundWork.summary("second")).toBeUndefined();
    expect(h.observations.size).toBe(0);
    await h.watches.subscribe("first", url);
    await h.watches.archive("first");
    expect(h.backgroundWork.list("first")).toEqual([]);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "shares the next turn with a child report when unsubscribe is %s",
  async (unsubscribe) => {
    vi.useFakeTimers();
    const home = await createTestHome();
    const h = createHarness(home);
    try {
      await h.watches.start();
      await h.watches.subscribe("parent", url);
      h.busy.add("parent");
      const report = h.messages.enqueue({
        recipientId: "parent",
        source: { kind: "agent-message", agentId: "child" },
        prompt: "Child report",
      });
      await h.observations.get(url)!.snapshot({
        ...initial,
        activity: [{ id: "review", kind: "review", url: reviewUrl }],
      });
      await vi.advanceTimersByTimeAsync(32_000);
      expect(h.turns).toEqual([]);
      const dispatches = h.messages.waitForDispatch("parent", new AbortController().signal);
      if (unsubscribe)
        await expect(h.watches.unsubscribe("parent", url)).resolves.toMatchObject({
          removed: true,
        });
      h.idle("parent");
      await report.dispatched;
      await dispatches;
      expect(h.turns).toHaveLength(1);
      const delivered = parseAgentMessages(h.turns[0]!.prompt);
      expect(delivered).toEqual([
        expect.objectContaining({
          source: { kind: "agent-message", agentId: "child" },
          text: "Child report",
        }),
        ...(!unsubscribe
          ? [
              expect.objectContaining({
                source: { kind: "change-request-update", url },
                text: expect.stringContaining(reviewUrl),
              }),
            ]
          : []),
      ]);
    } finally {
      await h.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("shares one observation and preserves a fixed digest window for a later subscriber", async () => {
  vi.useFakeTimers();
  const home = await createTestHome();
  const h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("first", url);
    await h.watches.subscribe("first", url);
    const observer = h.observations.get(url)!;
    const checkUrl = "https://github.com/owner/repo/actions/runs/1";
    const failing = {
      ...initial,
      checksState: "failed" as const,
      checks: [{ id: "1", name: "build", state: "failed" as const, url: checkUrl }],
    };
    await observer.snapshot(failing);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(h.watches.subscribe("second", url)).resolves.toMatchObject({
      checks: failing.checks,
    });
    expect(h.observations.get(url)).toBe(observer);
    await observer.snapshot({
      ...failing,
      activity: [{ id: "101", kind: "comment", url: url + "#issuecomment-101" }],
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.messages.hasPending("first")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(h.turns).toHaveLength(2);
    expect(h.turns.find(({ recipientId }) => recipientId === "first")?.prompt).toContain(checkUrl);
    expect(h.turns.find(({ recipientId }) => recipientId === "second")?.prompt).not.toContain(
      checkUrl,
    );
    expect(h.turns.every(({ prompt }) => prompt.includes("#issuecomment-101"))).toBe(true);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("can withdraw a terminal digest after its observation has stopped", async () => {
  vi.useFakeTimers();
  const home = await createTestHome();
  const h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("first", url);
    await h.watches.subscribe("second", url);
    h.busy.add("first");
    await h.observations.get(url)!.snapshot({ ...initial, state: "merged" });
    expect(h.observations.has(url)).toBe(false);
    expect(h.backgroundWork.list("first")).toEqual([]);
    expect(h.backgroundWork.list("second")).toEqual([]);
    await vi.advanceTimersByTimeAsync(32_000);
    await expect(h.watches.unsubscribe("first", url)).resolves.toMatchObject({ removed: true });
    h.idle("first");
    expect(h.turns).toEqual([
      { recipientId: "second", prompt: expect.stringContaining("Change request merged.") },
    ]);
    await expect(h.watches.unsubscribe("second", url)).resolves.toMatchObject({ removed: false });
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("retains the current observation as the last subscriber leaves and a new one joins", async () => {
  const home = await createTestHome();
  const h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("first", url);
    const observer = h.observations.get(url)!;
    await observer.snapshot({ ...initial, headSha: "new-head" });
    const [, joined] = await Promise.all([
      h.watches.unsubscribe("first", url),
      h.watches.subscribe("second", url),
    ]);
    expect(joined).toMatchObject({ subscribed: true, headSha: "new-head" });
    expect(h.observations.get(url)).toBe(observer);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps a durable baseline across restart and drops undelivered digests", async () => {
  vi.useFakeTimers();
  const home = await createTestHome();
  let h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("first", url);
    const [beforeRestart] = h.backgroundWork.list("first");
    h.busy.add("first");
    await h.observations
      .get(url)!
      .snapshot({ ...initial, headSha: "new-head", checksState: "passed" });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.messages.hasPending("first")).toBe(false);
    await h.close();
    expect(h.turns).toEqual([]);

    h = createHarness(home, { observationFails: true });
    await h.watches.start();
    expect(h.backgroundWork.list("first")).toEqual([
      { ...beforeRestart, stopToken: expect.any(String) },
    ]);
    const result = await Promise.race([
      h.watches.subscribe("first", url),
      Promise.resolve().then(async () => {
        await vi.advanceTimersByTimeAsync(100);
        return "subscribe still pending";
      }),
    ]);
    expect(result).toMatchObject({ headSha: "new-head", subscribed: true, stale: true });
    await vi.advanceTimersByTimeAsync(32_000);
    expect(h.turns).toEqual([]);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("recovers active watches even when pruning archived watchers cannot be written", async () => {
  const home = await createTestHome();
  const file = join(home, "change-request-watches.json");
  const backup = join(home, "saved-watches.json");
  let h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("archived", url);
    await h.watches.subscribe("active", url);
    await h.close();
    const stored = await readFile(file, "utf8");
    h = createHarness(home, {
      async isActive(id) {
        if (id !== "archived") return true;
        await rename(file, backup);
        await mkdir(file);
        return false;
      },
    });
    await h.watches.start();
    expect(h.backgroundWork.list("archived")).toEqual([]);
    expect(h.backgroundWork.summary("active")).toEqual({ count: 1 });
    await expect(h.watches.unsubscribe("archived", url)).resolves.toMatchObject({ removed: false });
    await expect(h.watches.subscribe("active", url)).resolves.toMatchObject({ subscribed: true });
    expect(await readFile(backup, "utf8")).toBe(stored);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});
