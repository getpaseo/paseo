import { describe, expect, it } from "vitest";
import { createViewHistoryTracker, shouldRecordPathname } from "@/navigation/view-history-tracker";

describe("createViewHistoryTracker", () => {
  it("walks back and forward through recorded views", () => {
    const tracker = createViewHistoryTracker();
    tracker.record("/a");
    tracker.record("/b");
    tracker.record("/c");

    expect(tracker.goBack()).toBe("/b");
    expect(tracker.goBack()).toBe("/a");
    expect(tracker.goForward()).toBe("/b");
    expect(tracker.goForward()).toBe("/c");
  });

  it("returns null at the boundaries", () => {
    const tracker = createViewHistoryTracker();
    expect(tracker.goBack()).toBeNull();
    expect(tracker.goForward()).toBeNull();

    tracker.record("/a");
    expect(tracker.goBack()).toBeNull();
    expect(tracker.goForward()).toBeNull();
  });

  it("ignores consecutive duplicates", () => {
    const tracker = createViewHistoryTracker();
    tracker.record("/a");
    tracker.record("/a");
    tracker.record("/b");

    expect(tracker.goBack()).toBe("/a");
    expect(tracker.goBack()).toBeNull();
  });

  it("truncates the forward stack when a new view is recorded after going back", () => {
    const tracker = createViewHistoryTracker();
    tracker.record("/a");
    tracker.record("/b");
    tracker.record("/c");

    expect(tracker.goBack()).toBe("/b");
    tracker.record("/d");

    expect(tracker.goForward()).toBeNull();
    expect(tracker.goBack()).toBe("/b");
    expect(tracker.goBack()).toBe("/a");
  });
});

describe("shouldRecordPathname", () => {
  it("records ordinary app and workspace routes", () => {
    expect(shouldRecordPathname("/settings/general")).toBe(true);
    expect(shouldRecordPathname("/h/srv_1/workspace/ws_1")).toBe(true);
    expect(shouldRecordPathname("/new")).toBe(true);
  });

  it("skips transient redirect routes", () => {
    expect(shouldRecordPathname("/")).toBe(false);
    expect(shouldRecordPathname("/h/srv_1")).toBe(false);
    expect(shouldRecordPathname("/h/srv_1/")).toBe(false);
    expect(shouldRecordPathname("/h/srv_1/agent/agent_1")).toBe(false);
  });
});
