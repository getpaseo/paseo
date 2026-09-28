import { appendFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { PiChildSessionFollower } from "./child-session-follower.js";
import {
  ManualChildSessionScheduler,
  childEntry,
  createChildSessionFile,
  streamTexts,
} from "./child-session-fixture.js";

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";

function streamIds(events: readonly AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "provider_subagent" && event.event.type === "timeline" ? [event.event.id] : [],
  );
}

function setup(options: { maxFollowedFiles?: number; hasPoll?: boolean } = {}) {
  const events: AgentStreamEvent[] = [];
  const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
  const scheduler = new ManualChildSessionScheduler();
  let ticks = 0;
  const follower = new PiChildSessionFollower({
    onEvents: (batch) => events.push(...batch),
    onTick: () => {
      ticks += 1;
    },
    hasPoll: () => options.hasPoll === true,
    onWarn: (message, details) => warnings.push({ message, details }),
    scheduler,
    intervalMs: 1,
    ...(options.maxFollowedFiles === undefined
      ? {}
      : { maxFollowedFiles: options.maxFollowedFiles }),
  });
  return {
    events,
    warnings,
    scheduler,
    follower,
    get ticks() {
      return ticks;
    },
  };
}

describe("Pi child session follower", () => {
  test("emits only rows appended since the last read", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const harness = setup({ file });
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
      childSessions: [{ id: "child", file }],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first"]));

    appendFileSync(file, childEntry("assistant", "second", T2));
    harness.scheduler.runScheduled();
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first", "second"]));
    expect(harness.ticks).toBe(1);
    harness.follower.close();
  });

  test("stops once the child reaches a terminal status", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const harness = setup({ file });
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
      childSessions: [{ id: "child", file }],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first"]));
    expect(harness.follower.active).toBe(true);

    appendFileSync(file, childEntry("assistant", "last", T2));
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "completed" }],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first", "last"]));
    expect(harness.follower.active).toBe(false);
    harness.follower.close();
  });

  test("a presentation-only upsert does not end the follow", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const harness = setup({ file });
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
      childSessions: [{ id: "child", file }],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first"]));

    harness.follower.accept("ext", { subagents: [{ type: "upsert", id: "child" }] });
    expect(harness.follower.active).toBe(true);

    appendFileSync(file, childEntry("assistant", "second", T2));
    harness.scheduler.runScheduled();
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first", "second"]));
    harness.follower.close();
  });

  test("reads nothing more after close", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const harness = setup({ file });
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
      childSessions: [{ id: "child", file }],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["first"]));

    harness.follower.close();
    expect(harness.scheduler.scheduled).toBe(false);
    expect(harness.follower.active).toBe(false);

    appendFileSync(file, childEntry("assistant", "after close", T2));
    harness.scheduler.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamTexts(harness.events)).toEqual(["first"]);
  });

  test("follows only up to its file limit", async () => {
    const first = createChildSessionFile(childEntry("user", "one", T1));
    const second = createChildSessionFile(childEntry("user", "two", T1));
    const harness = setup({ file: first, maxFollowedFiles: 1 });
    harness.follower.accept("ext", {
      subagents: [
        { type: "upsert", id: "child-1", status: "running" },
        { type: "upsert", id: "child-2", status: "running" },
      ],
      childSessions: [
        { id: "child-1", file: first },
        { id: "child-2", file: second },
      ],
    });
    await vi.waitFor(() => expect(streamTexts(harness.events)).toEqual(["one"]));
    expect(streamIds(harness.events)).toEqual(["child-1"]);
    expect(harness.warnings).toEqual([
      { message: "Pi child session follow limit reached", details: { file: second } },
    ]);
    harness.follower.close();
  });

  test("does not poll a running child that names no file and whose extension has no poll hook", () => {
    const harness = setup();
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
    });
    expect(harness.follower.active).toBe(false);
    expect(harness.scheduler.scheduled).toBe(false);
    harness.follower.close();
  });

  test("polls an extension that reports a running child", async () => {
    const harness = setup({ hasPoll: true });
    harness.follower.accept("ext", {
      subagents: [{ type: "upsert", id: "child", status: "running" }],
    });
    expect(harness.follower.active).toBe(true);
    await vi.waitFor(() => expect(harness.scheduler.scheduled).toBe(true));
    harness.follower.close();
  });
});
