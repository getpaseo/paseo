import { describe, expect, it } from "vitest";
import {
  createElementSelectorController,
  type BrowserElementSelection,
  type ElementSelectorOutcome,
  type ElementSelectorRuntime,
  type ElementSelectorWebview,
} from "./element-selector.electron";

function selectorHarness() {
  let installed: ((state: "installed" | "loading" | "unavailable") => void) | undefined;
  let result: ((selection: BrowserElementSelection | null) => void) | undefined;
  let timeout: (() => void) | undefined;
  const cleared: string[] = [];
  const destroyed: string[] = [];
  const stopped: string[] = [];
  const cancelledTimeouts: number[] = [];
  const runtime: ElementSelectorRuntime = {
    token: () => "session-1",
    install: () =>
      new Promise((resolve) => {
        installed = resolve;
      }),
    watch: (_webview, token, onResult) => {
      result = onResult;
      return () => stopped.push(token);
    },
    clear: (_webview, token) => cleared.push(token),
    destroy: (_webview, token) => destroyed.push(token),
    timeout: (callback) => {
      timeout = callback;
      return 7;
    },
    cancelTimeout: (id) => cancelledTimeouts.push(id),
  };
  const webview = { isConnected: true, isLoading: () => false } as ElementSelectorWebview;
  return {
    runtime,
    webview,
    cleared,
    destroyed,
    stopped,
    cancelledTimeouts,
    install: (state: "installed" | "loading" | "unavailable") => installed?.(state),
    select: (selection: BrowserElementSelection | null) => result?.(selection),
    expire: () => timeout?.(),
  };
}

async function settleInstallation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("element selector owner", () => {
  it("owns installation through selected completion", async () => {
    const harness = selectorHarness();
    const outcomes: ElementSelectorOutcome[] = [];
    const controller = createElementSelectorController(harness.runtime);

    expect(
      controller.start({
        webview: harness.webview,
        mode: "annotate",
        onFinish: (outcome) => outcomes.push(outcome),
      }),
    ).toBe("started");
    harness.install("installed");
    await settleInstallation();
    const selection: BrowserElementSelection = {
      url: "https://example.test/form",
      selector: "#submit",
      tag: "button",
      text: "Submit",
      outerHTML: '<button id="submit">Submit</button>',
      computedStyles: {},
      boundingRect: { x: 10, y: 20, width: 80, height: 30 },
      reactSource: null,
      parentChain: ["form"],
      children: [],
    };
    harness.select(selection);

    expect(outcomes).toEqual([
      {
        type: "selected",
        mode: "annotate",
        selection,
      },
    ]);
    expect(harness.stopped).toEqual(["session-1"]);
    expect(harness.cancelledTimeouts).toEqual([7]);
  });

  it("cleans up a cancelled session even when guest installation finishes late", async () => {
    const harness = selectorHarness();
    const outcomes: ElementSelectorOutcome[] = [];
    const controller = createElementSelectorController(harness.runtime);

    controller.start({
      webview: harness.webview,
      mode: "screenshot",
      onFinish: (outcome) => outcomes.push(outcome),
    });
    controller.cancel();
    harness.install("installed");
    await settleInstallation();

    expect(outcomes).toEqual([{ type: "cancelled" }]);
    expect(harness.cleared).toEqual(["session-1"]);
    expect(harness.destroyed).toEqual(["session-1"]);
  });

  it("destroys the guest session when selection times out", () => {
    const harness = selectorHarness();
    const outcomes: ElementSelectorOutcome[] = [];
    const controller = createElementSelectorController(harness.runtime);

    controller.start({
      webview: harness.webview,
      mode: "annotate",
      onFinish: (outcome) => outcomes.push(outcome),
    });
    harness.expire();

    expect(outcomes).toEqual([{ type: "failed", reason: "timeout" }]);
    expect(harness.destroyed).toEqual(["session-1"]);
  });
});
