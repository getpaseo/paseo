import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  BrowserActivityEvent,
  BrowserHandoff,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import {
  browserActivityStatusBucket,
  describeNextBrowserActivityStep,
  isBrowserRunLocked,
  summarizeBrowserActivity,
  useBrowserActivityStore,
} from "./activity";

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;

function event(patch: Partial<BrowserActivityEvent> = {}): BrowserActivityEvent {
  return {
    runId: "run-1",
    workspaceId: "ws-1",
    browserId: "tab-a",
    kind: "goal",
    label: "Sign in",
    phase: "deciding",
    step: 2,
    steps: [],
    pauseRequested: false,
    updatedAt: 1,
    ...patch,
  };
}

function lookup(serverId: string, workspaceId: string, browserId: string) {
  return useBrowserActivityStore.getState().byBrowser[
    `${serverId}\u0000${workspaceId}\u0000${browserId}`
  ];
}

function handoff(patch: Partial<BrowserHandoff> = {}): BrowserHandoff {
  return {
    handoffId: "handoff-1",
    workspaceId: "ws-1",
    browserId: "tab-a",
    agentId: "agent-1",
    reason: "Sign in",
    status: "active",
    updatedAt: 1,
    ...patch,
  };
}

function activeHandoffId(serverId: string, browserId: string): string | undefined {
  return useBrowserActivityStore.getState().activeHandoffByBrowser[
    `${serverId}\u0000ws-1\u0000${browserId}`
  ]?.handoffId;
}

function handoffStatus(serverId: string, handoffId: string): string | undefined {
  return useBrowserActivityStore.getState().handoffs[`${serverId}\u0000${handoffId}`]?.status;
}

describe("browser activity store", () => {
  beforeEach(() =>
    useBrowserActivityStore.setState({ byBrowser: {}, handoffs: {}, activeHandoffByBrowser: {} }),
  );

  it("tracks the active handoff per tab and remembers how each one ended", () => {
    const store = useBrowserActivityStore.getState();
    store.applyHandoff("server-1", handoff());
    expect(activeHandoffId("server-1", "tab-a")).toBe("handoff-1");

    store.applyHandoff("server-1", handoff({ status: "done" }));
    store.applyHandoff("server-1", handoff({ handoffId: "handoff-2" }));
    store.applyHandoff("server-1", handoff({ status: "cancelled" }));

    expect(activeHandoffId("server-1", "tab-a")).toBe("handoff-2");
    expect(handoffStatus("server-1", "handoff-1")).toBe("cancelled");
    expect(handoffStatus("server-1", "handoff-2")).toBe("active");
  });

  it("drops active handoffs of one server on resubscribe but keeps ended ones", () => {
    const store = useBrowserActivityStore.getState();
    store.applyHandoff("server-1", handoff());
    store.applyHandoff("server-1", handoff({ handoffId: "handoff-2", status: "done" }));
    store.applyHandoff("server-2", handoff({ handoffId: "handoff-3" }));
    store.resetServer("server-1");

    expect(activeHandoffId("server-1", "tab-a")).toBeUndefined();
    expect(handoffStatus("server-1", "handoff-1")).toBeUndefined();
    expect(handoffStatus("server-1", "handoff-2")).toBe("done");
    expect(activeHandoffId("server-2", "tab-a")).toBe("handoff-3");
  });

  it("keeps runs apart by server, workspace, and browser", () => {
    const store = useBrowserActivityStore.getState();
    store.apply("server-1", event());
    store.apply("server-1", event({ runId: "run-2", workspaceId: "ws-2" }));
    store.apply("server-2", event({ runId: "run-3" }));

    expect(lookup("server-1", "ws-1", "tab-a")?.runId).toBe("run-1");
    expect(lookup("server-1", "ws-2", "tab-a")?.runId).toBe("run-2");
    expect(lookup("server-2", "ws-1", "tab-a")?.runId).toBe("run-3");
    expect(lookup("server-1", "ws-1", "tab-b")).toBeUndefined();
  });

  it("drops live runs of one server on resubscribe but keeps finished results", () => {
    const store = useBrowserActivityStore.getState();
    store.apply("server-1", event());
    store.apply("server-1", event({ runId: "run-2", browserId: "tab-b", phase: "finished" }));
    store.apply("server-2", event({ runId: "run-3" }));
    store.resetServer("server-1");

    expect(lookup("server-1", "ws-1", "tab-a")).toBeUndefined();
    expect(lookup("server-1", "ws-1", "tab-b")?.runId).toBe("run-2");
    expect(lookup("server-2", "ws-1", "tab-a")?.runId).toBe("run-3");
  });

  it("dismisses only the run it was shown for", () => {
    const store = useBrowserActivityStore.getState();
    store.apply("server-1", event({ runId: "run-2" }));
    store.dismiss("server-1", event({ runId: "run-1" }));
    expect(lookup("server-1", "ws-1", "tab-a")?.runId).toBe("run-2");
    store.dismiss("server-1", event({ runId: "run-2" }));
    expect(lookup("server-1", "ws-1", "tab-a")).toBeUndefined();
  });
});

describe("browser activity presentation", () => {
  it("never guesses Jev's next step and shows the exact next recipe step", () => {
    expect(describeNextBrowserActivityStep(event(), t)).toBe(
      "workspace.browser.activity.recheckPage",
    );
    expect(describeNextBrowserActivityStep(event({ phase: "finished" }), t)).toBeNull();
    expect(
      describeNextBrowserActivityStep(
        event({
          kind: "recipe",
          next: { operation: "click", target: { role: "button", name: "Save" }, status: "pending" },
        }),
        t,
      ),
    ).toBe("click · button “Save”");
  });

  it("announces observing and deciding as one state, then the chosen action", () => {
    expect(summarizeBrowserActivity(event({ phase: "observing" }), t)).toBe(
      summarizeBrowserActivity(event({ phase: "deciding" }), t),
    );
    expect(
      summarizeBrowserActivity(
        event({
          phase: "executing",
          action: {
            operation: "FILL",
            target: { role: "textbox", name: "Email" },
            valueSlot: "account",
            status: "active",
          },
        }),
        t,
      ),
    ).toBe('workspace.browser.activity.step {"step":2} · fill · textbox “Email” · ← account');
  });

  it("releases input only while paused or after the run", () => {
    expect(isBrowserRunLocked(null)).toBe(false);
    expect(isBrowserRunLocked(event())).toBe(true);
    expect(isBrowserRunLocked(event({ pauseRequested: true }))).toBe(true);
    expect(isBrowserRunLocked(event({ phase: "paused" }))).toBe(false);
    expect(isBrowserRunLocked(event({ phase: "finished" }))).toBe(false);
    expect(browserActivityStatusBucket(event({ phase: "paused" }))).toBe("needs_input");
    expect(
      browserActivityStatusBucket(
        event({ phase: "finished", result: { status: "failed", message: "x" } }),
      ),
    ).toBe("failed");
  });
});
