import { describe, expect, it } from "vitest";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";
import { resolveInvertedPromptJumpOffset } from "../prompt-jump-native";
import { resolveInvertedReadingRow } from "../reading-anchor";
import {
  createOutlineNavigation,
  type OutlineNavigationInput,
  type OutlineNavigationPort,
  type OutlineTimelineIdentity,
} from "./navigation";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function prompt(seq: number): StreamItem {
  return {
    id: `prompt-${seq}`,
    kind: "user_message",
    text: `prompt ${seq}`,
    timestamp: new Date(seq),
    timelineCursor: { epoch: "epoch-1", seq },
  };
}

function payload(seqs: number[], epoch = "epoch-1"): AgentTimelinePromptIndexPayload {
  return {
    requestId: "index-request",
    agentId: "agent-1",
    error: null,
    epoch,
    prompts: seqs.map((seq) => ({
      seq,
      timestamp: new Date(seq).toISOString(),
      preview: `prompt ${seq}`,
    })),
  };
}

function createHarness() {
  const requests: OutlineTimelineIdentity[] = [];
  const indexes: ReturnType<typeof deferred<AgentTimelinePromptIndexPayload>>[] = [];
  const fetches: ReturnType<typeof deferred<unknown>>[] = [];
  const plans: Parameters<OutlineNavigationPort["fetchTimeline"]>[1][] = [];
  const scrolls: string[] = [];
  const reveals: string[] = [];
  let errors = 0;
  const navigation = createOutlineNavigation({
    listPrompts(identity) {
      requests.push(identity);
      const request = deferred<AgentTimelinePromptIndexPayload>();
      indexes.push(request);
      return request.promise;
    },
    fetchTimeline(_identity, plan) {
      plans.push(plan);
      const request = deferred<unknown>();
      fetches.push(request);
      return request.promise;
    },
  });
  let input: OutlineNavigationInput = {
    serverId: "server-1",
    agentId: "agent-1",
    timelineEpoch: "epoch-1",
    enabled: true,
    supportsPromptIndex: true,
    latestPromptSeq: -1,
    tail: [],
    head: [],
    viewportRef: {
      current: {
        scrollToBottom() {},
        prepareForViewportChange() {},
        scrollToMessage(id) {
          scrolls.push(id);
        },
      },
    },
    onJumpError() {
      errors += 1;
    },
    mountedHistoryMessageIds: new Set(),
    revealLoadedMessage(id) {
      reveals.push(id);
      return true;
    },
  };
  function update(changes: Partial<OutlineNavigationInput> = {}) {
    input = { ...input, ...changes };
    navigation.update(input);
  }
  return {
    navigation,
    update,
    requests,
    indexes,
    fetches,
    plans,
    scrolls,
    reveals,
    getErrors: () => errors,
  };
}

// Drain the known list/fetch promise chain without timers or React rendering.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("outline navigation", () => {
  it("waits for an authoritative epoch and a host prompt-index capability", () => {
    const h = createHarness();
    h.update({ timelineEpoch: null });
    h.update({ timelineEpoch: "epoch-1", supportsPromptIndex: false });
    expect(h.requests).toEqual([]);
    h.update({ supportsPromptIndex: true });
    expect(h.requests.map((request) => request.agentId)).toEqual(["agent-1"]);
  });

  it("keeps the newest index across viewed prompt refreshes and rejects another epoch", async () => {
    const h = createHarness();
    h.update();
    h.update({ latestPromptSeq: 2, tail: [prompt(2)] });
    h.indexes[1]!.resolve(payload([2]));
    await settle();
    h.indexes[0]!.resolve(payload([1]));
    await settle();
    expect(h.navigation.getPrompts()).toEqual(payload([2]).prompts);
    h.update({ timelineEpoch: "epoch-2" });
    h.indexes[2]!.resolve(payload([99]));
    await settle();
    expect(h.navigation.getPrompts()).toEqual([]);
  });

  it("does not refresh for assistant deltas and refreshes after re-enabling", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([1]));
    await settle();
    h.update({
      head: [{ id: "answer", kind: "assistant_message", text: "chunk", timestamp: new Date(0) }],
    });
    expect(h.requests.length).toBe(1);
    h.update({ enabled: false });
    expect(h.navigation.getPrompts()).toEqual([]);
    h.update({ enabled: true });
    expect(h.requests.length).toBe(2);
  });

  it("reveals a loaded history prompt and scrolls only after its mounted window arrives", () => {
    const h = createHarness();
    h.update({ tail: [prompt(2)] });
    h.navigation.jumpToPrompt(2);
    expect(h.reveals).toEqual(["prompt-2"]);
    expect(h.scrolls).toEqual([]);
    h.update({ mountedHistoryMessageIds: new Set(["prompt-2"]) });
    h.update();
    expect(h.scrolls).toEqual(["prompt-2"]);
  });

  it("jumps directly to a live prompt", () => {
    const h = createHarness();
    h.update({ head: [prompt(2)], revealLoadedMessage: () => false });
    h.navigation.jumpToPrompt(2);
    expect(h.scrolls).toEqual(["prompt-2"]);
    expect(h.fetches).toEqual([]);
  });

  it("reveals an unloaded prompt fetched outside the mounted window without scrolling twice", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([2]));
    await settle();
    h.navigation.jumpToPrompt(2);
    expect(h.plans).toEqual([
      {
        direction: "before",
        cursor: { epoch: "epoch-1", seq: 23 },
        limit: 40,
        projection: "projected",
        mergeWindow: true,
      },
    ]);
    h.update({ tail: [prompt(2)] });
    expect(h.scrolls).toEqual([]);
    h.update({ mountedHistoryMessageIds: new Set(["prompt-2"]) });
    h.fetches[0]!.resolve(undefined);
    await settle();
    expect(h.scrolls).toEqual(["prompt-2"]);
  });

  it("waits for the viewed timeline to publish a fetched prompt after the fetch settles", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([2]));
    await settle();
    h.navigation.jumpToPrompt(2);
    h.fetches[0]!.resolve(undefined);
    await settle();
    h.update({ tail: [prompt(2)], mountedHistoryMessageIds: new Set(["prompt-2"]) });
    expect(h.scrolls).toEqual(["prompt-2"]);
  });

  it("reports a current jump failure and ignores a cancelled jump's late failure", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([2, 9]));
    await settle();
    h.navigation.jumpToPrompt(2);
    h.fetches[0]!.reject(new Error("disconnected"));
    await settle();
    expect(h.getErrors()).toBe(1);
    h.navigation.jumpToPrompt(9);
    h.navigation.cancelSelection();
    h.fetches[1]!.reject(new Error("cancelled"));
    await settle();
    expect(h.getErrors()).toBe(1);
  });

  it("advances repeated accessibility steps when every recent prompt clamps to offset zero", async () => {
    const h = createHarness();
    h.update({ head: [prompt(2), prompt(9), prompt(20)], revealLoadedMessage: () => false });
    h.indexes[0]!.resolve(payload([2, 9, 20]));
    await settle();
    const frames = new Map([
      ["prompt-20", { y: 0, height: 40 }],
      ["prompt-9", { y: 40, height: 40 }],
      ["prompt-2", { y: 80, height: 40 }],
    ]);
    const offsets = [...frames.values()].map((frame) =>
      resolveInvertedPromptJumpOffset({
        frameY: frame.y,
        frameHeight: frame.height,
        viewportHeight: 500,
        topInset: 0,
      }),
    );
    expect(offsets).toEqual([0, 0, 0]);
    expect(
      resolveInvertedReadingRow({ frames, offsetY: 0, viewportHeight: 500, topInset: 0 }),
    ).toEqual({ kind: "row", id: "prompt-2" });
    h.navigation.reportReadingPosition({ seq: 2, isPromptRow: true });
    h.navigation.stepToPrompt("increment");
    h.navigation.reportReadingPosition({ seq: 2, isPromptRow: true });
    h.navigation.stepToPrompt("increment");
    h.navigation.stepToPrompt("increment");
    expect(h.scrolls).toEqual(["prompt-9", "prompt-20"]);
    expect(h.navigation.activePrompt.getActiveSeq()).toBe(2);
    expect(h.navigation.activePrompt.getRequestedSeq()).toBe(20);
    h.navigation.stepToPrompt("decrement");
    expect(h.scrolls).toEqual(["prompt-9", "prompt-20", "prompt-9"]);
    expect(h.navigation.activePrompt.getRequestedSeq()).toBe(9);
  });

  it("returns accessibility selection to the reader on a manual gesture or explicit scrub", async () => {
    const h = createHarness();
    h.update({ head: [prompt(2), prompt(9), prompt(20)], revealLoadedMessage: () => false });
    h.indexes[0]!.resolve(payload([2, 9, 20]));
    await settle();
    h.navigation.reportReadingPosition({ seq: 2, isPromptRow: false });
    h.navigation.stepToPrompt("increment");
    h.navigation.cancelSelection();
    expect(h.navigation.activePrompt.getRequestedSeq()).toBeNull();
    h.navigation.reportReadingPosition({ seq: 9, isPromptRow: false });
    h.navigation.stepToPrompt("increment");
    h.navigation.jumpToPrompt(2);
    expect(h.navigation.activePrompt.getRequestedSeq()).toBeNull();
    expect(h.scrolls).toEqual(["prompt-9", "prompt-20", "prompt-2"]);
  });

  it("cancels an unloaded jump when a gesture takes ownership", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([2]));
    await settle();
    h.navigation.stepToPrompt("increment");
    h.navigation.cancelSelection();
    h.update({ tail: [prompt(2)], mountedHistoryMessageIds: new Set(["prompt-2"]) });
    h.fetches[0]!.resolve(undefined);
    await settle();
    expect(h.scrolls).toEqual([]);
    expect(h.navigation.activePrompt.getRequestedSeq()).toBeNull();
  });

  it("reinitializes selection and ignores old requests when the agent changes", async () => {
    const h = createHarness();
    h.update();
    h.indexes[0]!.resolve(payload([2]));
    await settle();
    h.navigation.reportReadingPosition({ seq: 2, isPromptRow: true });
    h.navigation.stepToPrompt("increment");
    h.navigation.jumpToPrompt(2);
    h.update({ agentId: "agent-2" });
    h.fetches[0]!.resolve(undefined);
    h.indexes[1]!.resolve(payload([9]));
    await settle();
    expect(h.navigation.activePrompt.getActiveSeq()).toBeNull();
    expect(h.navigation.activePrompt.getRequestedSeq()).toBeNull();
    expect(h.navigation.getPrompts()).toEqual(payload([9]).prompts);
    expect(h.scrolls).toEqual([]);
    h.navigation.dispose();
    h.update();
    expect(h.requests.length).toBe(3);
  });
});
