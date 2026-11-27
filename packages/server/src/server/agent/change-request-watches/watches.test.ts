import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { createChangeRequestWatches } from "./index.js";
import { AgentBackgroundWorkStore } from "../background-work/index.js";
import { createAgentMessageDelivery, parseAgentMessages } from "../agent-messages/index.js";
import type { ChangeRequestRouter } from "../../../services/change-request-router.js";
import type {
  ChangeRequestSnapshot,
  ChangeRequestSource,
} from "../../../services/change-request-source.js";

const url = "https://github.com/owner/repo/pull/42";
const gitlabUrl = "https://gitlab.com/org/sub/app/-/merge_requests/9";
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
  {
    isActive = async (_id: string) => true,
    observationFails = false,
    resolveFails = false,
    extraSources = {} as Record<string, ChangeRequestSource>,
  } = {},
) {
  const observations = new Map<string, Parameters<ChangeRequestSource["observe"]>[1]>();
  const backgroundWork = new AgentBackgroundWorkStore();
  const busy = new Set<string>();
  const turns: { recipientId: string; prompt: string }[] = [];
  const listeners = new Set<(id: string) => void>();
  const resolveCalls: string[] = [];
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
  function createFakeSource(
    describe: (address: string) => string,
    accepts: (input: string) => boolean,
  ): ChangeRequestSource {
    return {
      resolve: (input) => {
        if (!accepts(input)) throw new Error("Unsupported URL for fake forge");
        return input.replace(/\/+$/, "");
      },
      describe,
      observe(address, callbacks) {
        observations.set(address, callbacks);
        queueMicrotask(() => {
          if (observationFails) callbacks.error(new Error("Forge unavailable"));
          else void callbacks.snapshot(initial);
        });
        return () => observations.delete(address);
      },
    };
  }
  const sources: Record<string, ChangeRequestSource> = {
    github: createFakeSource(
      () => "owner/repo #42",
      (input) => input.includes("/pull/"),
    ),
    gitlab: createFakeSource(
      () => "org/sub/app !9",
      (input) => input.includes("/merge_requests/"),
    ),
    ...extraSources,
  };
  const router: ChangeRequestRouter = {
    async resolve(input) {
      resolveCalls.push(input);
      if (resolveFails) throw new Error("Host probe failed");
      const forge = input.includes("gitlab") ? "gitlab" : "github";
      const source = sources[forge];
      if (!source) throw new Error(`Unsupported forge: ${forge}`);
      return { forge, url: source.resolve(input) };
    },
    source(forge) {
      return sources[forge] ?? null;
    },
  };
  const watches = createChangeRequestWatches({
    router,
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
    resolveCalls,
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
    expect(h.backgroundWork.summary("first")).toEqual({ count: 1, runningCount: 0 });
    expect(h.backgroundWork.summary("second")).toEqual({ count: 1, runningCount: 0 });

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

test.each([0, 32_000])(
  "withdraws a terminal update without a host probe after %i ms",
  async (elapsed) => {
    vi.useFakeTimers();
    const home = await createTestHome();
    const enterpriseUrl = "https://github.example.com/owner/repo/pull/42";
    const { activity: _activity, ...snapshot } = initial;
    await writeFile(
      join(home, "change-request-watches.json"),
      JSON.stringify([
        {
          forge: "github",
          url: enterpriseUrl,
          snapshot,
          seenActivity: [],
          watchers: [{ agentId: "first" }],
        },
      ]),
    );
    const h = createHarness(home, { resolveFails: true });
    try {
      h.busy.add("first");
      await h.watches.start();
      await h.observations.get(enterpriseUrl)!.snapshot({ ...initial, state: "merged" });
      expect(h.observations.has(enterpriseUrl)).toBe(false);
      await vi.advanceTimersByTimeAsync(elapsed);
      await expect(h.watches.unsubscribe("first", `${enterpriseUrl}/`)).resolves.toEqual({
        url: enterpriseUrl,
        removed: true,
      });
      expect(h.resolveCalls).toEqual([]);
      h.idle("first");
      await vi.advanceTimersByTimeAsync(32_000);
      expect(h.turns).toEqual([]);
    } finally {
      await h.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

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
    expect(h.backgroundWork.summary("active")).toEqual({ count: 1, runningCount: 0 });
    await expect(h.watches.unsubscribe("archived", url)).resolves.toMatchObject({ removed: false });
    await expect(h.watches.subscribe("active", url)).resolves.toMatchObject({ subscribed: true });
    expect(await readFile(backup, "utf8")).toBe(stored);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("persists forge ids, restores legacy GitHub watches without probing, and preserves unknown forges", async () => {
  const home = await createTestHome();
  const file = join(home, "change-request-watches.json");
  const legacyRecord = {
    url,
    snapshot: {
      state: "open",
      headSha: "aaa",
      checksState: "pending",
      checks: [],
      reviewDecision: null,
    },
    seenActivity: [],
    watchers: [{ agentId: "legacy-agent", startedAt: "2026-01-01T00:00:00.000Z" }],
  };
  const unknownForgeRecord = {
    forge: "futureforge",
    url: "https://future.example.com/team/repo/cr/5",
    snapshot: legacyRecord.snapshot,
    seenActivity: [],
    watchers: [{ agentId: "future-agent", startedAt: "2026-01-01T00:00:00.000Z" }],
  };
  const strippedGitLabRecord = {
    url: gitlabUrl,
    snapshot: legacyRecord.snapshot,
    seenActivity: [],
    watchers: [{ agentId: "gitlab-agent", startedAt: "2026-01-01T00:00:00.000Z" }],
  };
  await writeFile(
    file,
    JSON.stringify([legacyRecord, strippedGitLabRecord, unknownForgeRecord]),
    "utf8",
  );

  const h = createHarness(home, { resolveFails: true });
  try {
    await h.watches.start();
    expect(h.resolveCalls).toEqual([]);
    expect(h.backgroundWork.list("legacy-agent")).toEqual([
      expect.objectContaining({ description: "owner/repo #42", kind: "monitor" }),
    ]);
    expect(h.backgroundWork.list("gitlab-agent")).toEqual([
      expect.objectContaining({ description: "org/sub/app !9", kind: "monitor" }),
    ]);
    expect(h.observations.has(url)).toBe(true);
    expect(h.observations.has(gitlabUrl)).toBe(true);

    // Unsubscribing an active watch succeeds even when host resolution is temporarily down.
    await expect(h.watches.unsubscribe("legacy-agent", `${url}/`)).resolves.toEqual({
      url,
      removed: true,
    });
    expect(h.backgroundWork.list("legacy-agent")).toEqual([]);
    const persisted = JSON.parse(await readFile(file, "utf8")) as Array<{
      forge?: string;
      url: string;
    }>;
    expect(persisted).toEqual([
      expect.objectContaining({ forge: "gitlab", url: gitlabUrl }),
      unknownForgeRecord,
    ]);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("watches multiple forges concurrently with forge-native descriptions and custom approval messages", async () => {
  vi.useFakeTimers();
  const home = await createTestHome();
  const file = join(home, "change-request-watches.json");
  const h = createHarness(home);
  try {
    await h.watches.start();
    await h.watches.subscribe("agent-1", url);
    await h.watches.subscribe("agent-1", gitlabUrl);
    expect(h.backgroundWork.list("agent-1").map((item) => item.description)).toEqual([
      "owner/repo #42",
      "org/sub/app !9",
    ]);

    const persisted = JSON.parse(await readFile(file, "utf8")) as Array<{
      forge?: string;
      url: string;
    }>;
    expect(persisted.map(({ forge, url: entryUrl }) => ({ forge, url: entryUrl }))).toEqual([
      { forge: "github", url },
      { forge: "gitlab", url: gitlabUrl },
    ]);

    await h.observations.get(gitlabUrl)!.snapshot({
      ...initial,
      activity: [
        {
          id: "approval-note:77",
          kind: "approval",
          url: `${gitlabUrl}#note_77`,
          message: `Merge request approved by @alice (1/1 approvals): ${gitlabUrl}#note_77`,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(32_000);
    expect(h.turns).toEqual([
      {
        recipientId: "agent-1",
        prompt: expect.stringContaining(
          `Merge request approved by @alice (1/1 approvals): ${gitlabUrl}#note_77`,
        ),
      },
    ]);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});
