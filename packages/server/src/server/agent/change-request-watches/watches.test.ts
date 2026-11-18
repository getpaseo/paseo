import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { createChangeRequestWatches } from "./index.js";
import { waitForAgentRunStart } from "../agent-prompt.js";
import type {
  ChangeRequestSnapshot,
  ChangeRequestSource,
} from "../../../services/change-request-source.js";

const url = "https://github.com/owner/repo/pull/42";
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

test("shares one observation and restores a busy recipient's unsent digest", async () => {
  const home = await createTestHome();
  vi.useFakeTimers();
  let listener: Parameters<ChangeRequestSource["observe"]>[1] | undefined;
  let observations = 0;
  const delivered: [string, string][] = [];
  const busy = new Set<string>();
  const source: ChangeRequestSource = {
    resolve: () => url,
    observe(_url, callbacks) {
      observations++;
      listener = callbacks;
      queueMicrotask(() => void callbacks.snapshot(initial));
      return () => {
        listener = undefined;
      };
    },
  };
  const create = () =>
    createChangeRequestWatches({
      source,
      paseoHome: home,
      isActive: async () => true,
      deliver: async (agentId, digest) => {
        if (busy.has(agentId)) return false;
        delivered.push([agentId, digest.text]);
        return true;
      },
      logger: pino({ enabled: false }),
    });
  let watches = create();
  try {
    await watches.start();
    await expect(watches.subscribe("first", url)).resolves.toMatchObject({
      url,
      state: "open",
      subscribed: true,
    });
    await watches.subscribe("first", url);
    expect(observations).toBe(1);

    const failing = {
      ...initial,
      checksState: "failed" as const,
      checks: [
        {
          id: "1",
          name: "build",
          state: "failed" as const,
          url: "https://github.com/owner/repo/actions/runs/1",
        },
      ],
    };
    await listener!.snapshot(failing);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(watches.subscribe("second", url)).resolves.toMatchObject({
      checks: failing.checks,
    });
    await listener!.snapshot({
      ...failing,
      activity: [{ id: "comment-101", kind: "comment", url: url + "#issuecomment-101" }],
    });
    busy.add("second");
    await vi.advanceTimersByTimeAsync(15_000);
    await watches.flush();
    expect(delivered).toEqual([["first", expect.stringContaining("build")]]);
    expect(delivered[0]?.[1]).toContain("#issuecomment-101");
    expect(delivered[0]?.[1]).toContain(failing.checks[0]!.url);

    await watches.close();
    watches = create();
    await watches.start();
    busy.clear();
    await watches.flush();
    expect(delivered[1]).toEqual(["second", expect.stringContaining("#issuecomment-101")]);
    expect(delivered[1]?.[1]).not.toContain("build");
  } finally {
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("withdraws an unsent update without blocking another PR or stopping another recipient", async () => {
  const home = await createTestHome();
  vi.useFakeTimers();
  const observers = new Map<string, Parameters<ChangeRequestSource["observe"]>[1]>();
  const attempt = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const watches = createChangeRequestWatches({
    source: {
      resolve: (input) => input,
      observe(address, callbacks) {
        observers.set(address, callbacks);
        queueMicrotask(() => void callbacks.snapshot(initial));
        return () => observers.delete(address);
      },
    },
    paseoHome: home,
    isActive: async () => true,
    async deliver(agent, digest) {
      if (agent === "first") {
        attempt.resolve();
        await release.promise;
      }
      if (!digest.isPending()) return false;
      delivered.push(agent);
      return true;
    },
    logger: pino({ enabled: false }),
  });
  try {
    await watches.start();
    await watches.subscribe("first", url);
    await watches.subscribe("second", url);
    await observers.get(url)!.snapshot({ ...initial, state: "merged" });
    expect(observers.has(url)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await attempt.promise;

    const other = "https://github.com/owner/repo/pull/43";
    await expect(watches.subscribe("third", other)).resolves.toMatchObject({ subscribed: true });
    await expect(watches.unsubscribe("first", url)).resolves.toMatchObject({ removed: true });
    release.resolve();
    await watches.flush();
    expect(delivered).toEqual(["second"]);
    await expect(watches.unsubscribe("second", url)).resolves.toMatchObject({ removed: false });
    await watches.archive("third");
    expect(observers.size).toBe(0);
  } finally {
    release.resolve();
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("retains the current observation as the last subscriber leaves and a new one joins", async () => {
  const home = await createTestHome();
  let observer: Parameters<ChangeRequestSource["observe"]>[1] | undefined;
  const watches = createChangeRequestWatches({
    source: {
      resolve: (input) => input,
      observe(_address, callbacks) {
        observer = callbacks;
        queueMicrotask(() => void callbacks.snapshot(initial));
        return () => {
          observer = undefined;
        };
      },
    },
    paseoHome: home,
    isActive: async () => true,
    deliver: async () => true,
    logger: pino({ enabled: false }),
  });
  try {
    await watches.start();
    await watches.subscribe("first", url);
    await observer!.snapshot({ ...initial, headSha: "new-head" });
    const [, joined] = await Promise.all([
      watches.unsubscribe("first", url),
      watches.subscribe("second", url),
    ]);
    expect(joined).toMatchObject({ subscribed: true, headSha: "new-head" });
    expect(observer).toBeDefined();
  } finally {
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("records an admitted update acknowledged during provider shutdown", async () => {
  const home = await createTestHome();
  vi.useFakeTimers();
  let observer: Parameters<ChangeRequestSource["observe"]>[1] | undefined;
  const starting = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const deliveries: string[] = [];
  const create = () =>
    createChangeRequestWatches({
      source: {
        resolve: (input) => input,
        observe(_address, callbacks) {
          observer = callbacks;
          queueMicrotask(() => void callbacks.snapshot(initial));
          return () => {
            observer = undefined;
          };
        },
      },
      paseoHome: home,
      isActive: async () => true,
      async deliver(_agent, digest) {
        starting.resolve();
        await waitForAgentRunStart(accepted.promise, digest.signal);
        deliveries.push(digest.id);
        return true;
      },
      logger: pino({ enabled: false }),
    });
  let watches = create();
  try {
    await watches.start();
    await watches.subscribe("first", url);
    await observer!.snapshot({ ...initial, state: "merged" });
    await vi.advanceTimersByTimeAsync(30_000);
    await starting.promise;

    // The daemon freezes observation and new admission, then tears down providers.
    watches.stop();
    accepted.resolve();
    await watches.close();

    watches = create();
    await watches.start();
    await watches.flush();
    expect(deliveries).toHaveLength(1);
  } finally {
    accepted.resolve();
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("returns the durable baseline while a restored observation is failing", async () => {
  const home = await createTestHome();
  let failing = false;
  const create = () =>
    createChangeRequestWatches({
      source: {
        resolve: (input) => input,
        observe(_address, callbacks) {
          queueMicrotask(() => {
            if (failing) callbacks.error(new Error("GitHub unavailable"));
            else void callbacks.snapshot(initial);
          });
          return () => {};
        },
      },
      paseoHome: home,
      isActive: async () => true,
      deliver: async () => true,
      logger: pino({ enabled: false }),
    });
  let watches = create();
  try {
    await watches.start();
    await watches.subscribe("first", url);
    await watches.close();
    failing = true;
    watches = create();
    await watches.start();
    const result = await Promise.race([
      watches.subscribe("first", url),
      new Promise((resolve) => setTimeout(() => resolve("subscribe still pending"), 100)),
    ]);
    expect(result).toMatchObject({ headSha: initial.headSha, subscribed: true, stale: true });
  } finally {
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("sends all due digests in one turn when an agent becomes idle", async () => {
  const home = await createTestHome();
  vi.useFakeTimers();
  const observers = new Map<string, Parameters<ChangeRequestSource["observe"]>[1]>();
  let busy = true;
  const deliveries: string[] = [];
  const watches = createChangeRequestWatches({
    source: {
      resolve: (input) => input,
      observe(address, callbacks) {
        observers.set(address, callbacks);
        queueMicrotask(() => void callbacks.snapshot(initial));
        return () => observers.delete(address);
      },
    },
    paseoHome: home,
    isActive: async () => true,
    async deliver(_agent, digest) {
      if (busy) return false;
      deliveries.push(digest.text);
      return true;
    },
    logger: pino({ enabled: false }),
  });
  try {
    const second = "https://github.com/owner/repo/pull/43";
    await watches.start();
    await watches.subscribe("first", url);
    await watches.subscribe("first", second);
    for (const [address, id] of [
      [url, "1"],
      [second, "2"],
      [url, "3"],
    ]) {
      await observers.get(address)!.snapshot({
        ...initial,
        activity: [{ id, kind: "comment", url: address + "#issuecomment-" + id }],
      });
      await vi.advanceTimersByTimeAsync(31_000);
    }
    busy = false;
    watches.agentIdle("first");
    await watches.flush();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(url + "#issuecomment-1");
    expect(deliveries[0]?.match(/issuecomment-\d/g)).toEqual([
      "issuecomment-1",
      "issuecomment-2",
      "issuecomment-3",
    ]);
  } finally {
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("recovers active watches even when pruning archived watchers cannot be written", async () => {
  const home = await createTestHome();
  const file = join(home, "change-request-watches.json");
  const backup = join(home, "saved-watches.json");
  const create = (isActive: (id: string) => Promise<boolean>) =>
    createChangeRequestWatches({
      source: {
        resolve: (input) => input,
        observe(_address, callbacks) {
          queueMicrotask(() => void callbacks.snapshot(initial));
          return () => {};
        },
      },
      paseoHome: home,
      isActive,
      deliver: async () => true,
      logger: pino({ enabled: false }),
    });
  let watches = create(async () => true);
  try {
    await watches.start();
    await watches.subscribe("archived", url);
    await watches.subscribe("active", url);
    await watches.close();
    const stored = await readFile(file, "utf8");
    watches = create(async (id) => {
      if (id !== "archived") return true;
      await rename(file, backup);
      await mkdir(file);
      return false;
    });
    await watches.start();
    await expect(watches.unsubscribe("archived", url)).resolves.toMatchObject({ removed: false });
    await expect(watches.subscribe("active", url)).resolves.toMatchObject({ subscribed: true });
    expect(await readFile(backup, "utf8")).toBe(stored);
  } finally {
    await watches.close();
    await rm(home, { recursive: true, force: true });
  }
});
