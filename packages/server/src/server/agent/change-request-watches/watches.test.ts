import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { createChangeRequestWatches } from "./index.js";
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
      checks: [{ id: "1", name: "build", state: "failed" as const }],
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
