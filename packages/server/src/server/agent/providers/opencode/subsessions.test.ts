import { describe, expect, it } from "vitest";
import type {
  Event as OpenCodeEvent,
  Session as OpenCodeSession,
} from "@opencode-ai/sdk/v2/client";
import { OpenCodeSubsessionTracker } from "./subsessions.js";

const ROOT = "ses_root";

function makeSession(id: string, parentID: string | undefined, title = ""): OpenCodeSession {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory: "/tmp/project",
    title,
    version: "1",
    time: { created: 1, updated: 1 },
    ...(parentID ? { parentID } : {}),
  };
}

function sessionCreated(id: string, parentID: string | undefined, title = ""): OpenCodeEvent {
  return {
    id: `evt_${id}`,
    type: "session.created",
    properties: { sessionID: id, info: makeSession(id, parentID, title) },
  };
}

function sessionUpdated(id: string, parentID: string | undefined, title = ""): OpenCodeEvent {
  return {
    id: `evt_${id}`,
    type: "session.updated",
    properties: { sessionID: id, info: makeSession(id, parentID, title) },
  };
}

function sessionStatus(id: string, statusType: "busy" | "idle"): OpenCodeEvent {
  return {
    id: `evt_status_${id}`,
    type: "session.status",
    properties: {
      sessionID: id,
      status: statusType === "idle" ? { type: "idle" } : { type: "busy" },
    },
  };
}

describe("OpenCodeSubsessionTracker", () => {
  it("tracks a created child session as running with its title", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);

    expect(tracker.handleEvent(sessionCreated("ses_child", ROOT, "Investigate flaky test"))).toBe(
      true,
    );

    expect(tracker.list()).toEqual([
      {
        id: "ses_child",
        title: "Investigate flaky test",
        status: "running",
        parentSessionId: ROOT,
      },
    ]);
  });

  it("ignores sessions that belong to another agent's tree and root sessions", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);

    expect(tracker.handleEvent(sessionCreated("ses_other", "ses_unrelated"))).toBe(false);
    expect(tracker.handleEvent(sessionCreated("ses_root_like", undefined))).toBe(false);
    expect(tracker.list()).toEqual([]);
  });

  it("tracks nested descendants once their parent is known", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);

    tracker.handleEvent(sessionCreated("ses_child", ROOT));
    expect(tracker.handleEvent(sessionCreated("ses_grandchild", "ses_child"))).toBe(true);

    const ids = tracker.list().map((s) => [s.id, s.parentSessionId]);
    expect(ids).toEqual([
      ["ses_child", ROOT],
      ["ses_grandchild", "ses_child"],
    ]);
  });

  it("updates live status from session.status and session.idle events", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);
    tracker.handleEvent(sessionCreated("ses_child", ROOT));

    expect(tracker.handleEvent(sessionStatus("ses_child", "idle"))).toBe(true);
    expect(tracker.list()[0]?.status).toBe("idle");

    expect(tracker.handleEvent(sessionStatus("ses_child", "busy"))).toBe(true);
    expect(tracker.list()[0]?.status).toBe("running");

    const idleEvent: OpenCodeEvent = {
      id: "evt_idle",
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    };
    expect(tracker.handleEvent(idleEvent)).toBe(true);
    expect(tracker.list()[0]?.status).toBe("idle");

    // No change -> no re-emit.
    expect(tracker.handleEvent(idleEvent)).toBe(false);
  });

  it("marks a child as error on session.error and removes it on session.deleted", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);
    tracker.handleEvent(sessionCreated("ses_child", ROOT));

    const errorEvent: OpenCodeEvent = {
      id: "evt_err",
      type: "session.error",
      properties: { sessionID: "ses_child" },
    };
    expect(tracker.handleEvent(errorEvent)).toBe(true);
    expect(tracker.list()[0]?.status).toBe("error");

    const deletedEvent: OpenCodeEvent = {
      id: "evt_del",
      type: "session.deleted",
      properties: { sessionID: "ses_child", info: makeSession("ses_child", ROOT) },
    };
    expect(tracker.handleEvent(deletedEvent)).toBe(true);
    expect(tracker.list()).toEqual([]);
  });

  it("removes descendants when a parent subsession is deleted", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);
    tracker.handleEvent(sessionCreated("ses_child", ROOT));
    tracker.handleEvent(sessionCreated("ses_grandchild", "ses_child"));
    tracker.handleEvent(sessionCreated("ses_great_grandchild", "ses_grandchild"));

    expect(
      tracker.handleEvent({
        id: "evt_del_parent",
        type: "session.deleted",
        properties: { sessionID: "ses_child", info: makeSession("ses_child", ROOT) },
      }),
    ).toBe(true);
    expect(tracker.list()).toEqual([]);
  });

  it("picks up a late title via session.updated without resetting status", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);
    tracker.handleEvent(sessionCreated("ses_child", ROOT));
    tracker.handleEvent(sessionStatus("ses_child", "idle"));

    expect(tracker.handleEvent(sessionUpdated("ses_child", ROOT, "Summarized title"))).toBe(true);
    expect(tracker.list()).toEqual([
      { id: "ses_child", title: "Summarized title", status: "idle", parentSessionId: ROOT },
    ]);
  });

  it("seeds enumerated children as idle without overriding event-derived state", () => {
    const tracker = new OpenCodeSubsessionTracker(ROOT);
    tracker.handleEvent(sessionCreated("ses_live", ROOT));

    const changed = tracker.seed([
      { id: "ses_live", title: "Live child", parentSessionId: ROOT },
      { id: "ses_persisted", title: "Old child", parentSessionId: ROOT },
      { id: ROOT, title: "Root itself", parentSessionId: null },
    ]);

    expect(changed).toBe(true);
    expect(tracker.list()).toEqual([
      // Status from the live event stream wins; seed only fills the title.
      { id: "ses_live", title: "Live child", status: "running", parentSessionId: ROOT },
      { id: "ses_persisted", title: "Old child", status: "idle", parentSessionId: ROOT },
    ]);
  });
});
