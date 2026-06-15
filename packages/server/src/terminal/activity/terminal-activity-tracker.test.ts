import { describe, expect, it, vi } from "vitest";
import { TerminalActivityTracker } from "./terminal-activity-tracker.js";
import type { TerminalActivitySnapshot } from "./terminal-activity-tracker.js";

describe("TerminalActivityTracker — initial state", () => {
  it("starts as unknown", () => {
    const tracker = new TerminalActivityTracker();

    expect(tracker.getSnapshot().state).toBeNull();
  });
});

describe("TerminalActivityTracker — set", () => {
  it("updates the snapshot state", () => {
    const tracker = new TerminalActivityTracker();

    tracker.set("working");

    expect(tracker.getSnapshot().state).toBe("working");
  });
});

describe("TerminalActivityTracker — clearAttention", () => {
  it("moves attention back to idle", () => {
    const tracker = new TerminalActivityTracker();

    tracker.set("attention");

    expect(tracker.clearAttention()).toBe(true);
    expect(tracker.getSnapshot().state).toBe("idle");
  });

  it("leaves non-attention states unchanged", () => {
    const tracker = new TerminalActivityTracker();

    tracker.set("working");

    expect(tracker.clearAttention()).toBe(false);
    expect(tracker.getSnapshot().state).toBe("working");
  });
});

describe("TerminalActivityTracker — onChange listener", () => {
  it("fires when state changes", () => {
    const tracker = new TerminalActivityTracker();
    const changes: TerminalActivitySnapshot[] = [];
    tracker.onChange((snap) => changes.push(snap));

    tracker.set("working");

    expect(changes).toHaveLength(1);
    expect(changes[0].state).toBe("working");
  });

  it("does not fire when state stays the same", () => {
    const tracker = new TerminalActivityTracker();
    const changes: TerminalActivitySnapshot[] = [];
    tracker.onChange((snap) => changes.push(snap));

    tracker.clear();

    expect(changes).toHaveLength(0);
  });

  it("fires when state clears to unknown", () => {
    const tracker = new TerminalActivityTracker();
    const changes: TerminalActivitySnapshot[] = [];
    tracker.onChange((snap) => changes.push(snap));

    tracker.set("working");
    tracker.clear();

    expect(changes.map((change) => change.state)).toEqual(["working", null]);
  });

  it("listener can be unsubscribed", () => {
    const tracker = new TerminalActivityTracker();
    const changes: TerminalActivitySnapshot[] = [];
    const off = tracker.onChange((snap) => changes.push(snap));

    tracker.set("working");
    expect(changes).toHaveLength(1);

    off();
    tracker.set("idle");

    expect(changes).toHaveLength(1);
  });

  it("delivers the previous snapshot alongside each transition", () => {
    const tracker = new TerminalActivityTracker();
    const transitions: Array<{
      snapshot: TerminalActivitySnapshot;
      previous: TerminalActivitySnapshot;
    }> = [];
    tracker.onChange((snapshot, previous) => transitions.push({ snapshot, previous }));

    tracker.set("working");
    tracker.set("idle");

    expect(transitions).toHaveLength(2);
    expect(transitions[0].previous.state).toBeNull();
    expect(transitions[0].snapshot.state).toBe("working");
    expect(transitions[1].previous).toEqual(transitions[0].snapshot);
    expect(transitions[1].snapshot.state).toBe("idle");
  });
});

describe("TerminalActivityTracker — dispose", () => {
  it("removes listeners", () => {
    const tracker = new TerminalActivityTracker();
    const listener = vi.fn();
    tracker.onChange(listener);

    tracker.dispose();
    tracker.set("working");

    expect(listener).not.toHaveBeenCalled();
  });
});
