import { describe, expect, it } from "vitest";
import {
  initialPanelsState,
  panelsReducer,
  selectActivePanel,
  type NewWorkspacePanelsState,
} from "./panels-state";

describe("panels-state reducer", () => {
  it("initializes with an empty panel array and composer active (null)", () => {
    expect(initialPanelsState).toEqual({
      panels: [],
      activePanelId: null,
    });
    expect(selectActivePanel(initialPanelsState)).toBeNull();
  });

  it("adds a terminal panel and activates it", () => {
    const action = { type: "add-terminal" as const, terminalId: "term-1", createdAt: 1000 };
    const nextState = panelsReducer(initialPanelsState, action);

    expect(nextState).toEqual({
      panels: [
        {
          panelId: "term-1",
          kind: "terminal",
          terminalId: "term-1",
          createdAt: 1000,
        },
      ],
      activePanelId: "term-1",
    });
    expect(selectActivePanel(nextState)).toEqual({
      panelId: "term-1",
      kind: "terminal",
      terminalId: "term-1",
      createdAt: 1000,
    });
  });

  it("adds a browser panel and activates it", () => {
    const action = { type: "add-browser" as const, browserId: "browser-1", createdAt: 2000 };
    const nextState = panelsReducer(initialPanelsState, action);

    expect(nextState).toEqual({
      panels: [
        {
          panelId: "browser-1",
          kind: "browser",
          browserId: "browser-1",
          createdAt: 2000,
        },
      ],
      activePanelId: "browser-1",
    });
    expect(selectActivePanel(nextState)).toEqual({
      panelId: "browser-1",
      kind: "browser",
      browserId: "browser-1",
      createdAt: 2000,
    });
  });

  it("dedupes add-terminal if terminalId already exists (no-op)", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 }],
      activePanelId: "term-1",
    };

    const nextState = panelsReducer(state, {
      type: "add-terminal",
      terminalId: "term-1",
      createdAt: 3000,
    });

    expect(nextState).toBe(state);
  });

  it("dedupes add-browser if browserId already exists (no-op)", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 }],
      activePanelId: "browser-1",
    };

    const nextState = panelsReducer(state, {
      type: "add-browser",
      browserId: "browser-1",
      createdAt: 3000,
    });

    expect(nextState).toBe(state);
  });

  it("activates an existing panel", () => {
    const state: NewWorkspacePanelsState = {
      panels: [
        { panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 },
        { panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 },
      ],
      activePanelId: "browser-1",
    };

    const nextState = panelsReducer(state, { type: "activate", panelId: "term-1" });

    expect(nextState.activePanelId).toBe("term-1");
    expect(selectActivePanel(nextState)?.panelId).toBe("term-1");
  });

  it("no-ops when activating an unknown panel id", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 }],
      activePanelId: "term-1",
    };

    const nextState = panelsReducer(state, { type: "activate", panelId: "unknown-id" });

    expect(nextState).toBe(state);
  });

  it("activates composer (null activePanelId)", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 }],
      activePanelId: "term-1",
    };

    const nextState = panelsReducer(state, { type: "activate-composer" });

    expect(nextState.activePanelId).toBeNull();
    expect(selectActivePanel(nextState)).toBeNull();
  });

  it("keeps active panel unchanged when closing a non-active panel", () => {
    const state: NewWorkspacePanelsState = {
      panels: [
        { panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 },
        { panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 },
      ],
      activePanelId: "browser-1",
    };

    const nextState = panelsReducer(state, { type: "close", panelId: "term-1" });

    expect(nextState).toEqual({
      panels: [{ panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 }],
      activePanelId: "browser-1",
    });
  });

  it("falls back to last remaining panel in array order when closing active panel", () => {
    const state: NewWorkspacePanelsState = {
      panels: [
        { panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 },
        { panelId: "term-2", kind: "terminal", terminalId: "term-2", createdAt: 1500 },
        { panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 },
      ],
      activePanelId: "term-2",
    };

    const nextState = panelsReducer(state, { type: "close", panelId: "term-2" });

    expect(nextState).toEqual({
      panels: [
        { panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 },
        { panelId: "browser-1", kind: "browser", browserId: "browser-1", createdAt: 2000 },
      ],
      activePanelId: "browser-1",
    });
  });

  it("falls back to activePanelId = null when closing the last remaining panel", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 }],
      activePanelId: "term-1",
    };

    const nextState = panelsReducer(state, { type: "close", panelId: "term-1" });

    expect(nextState).toEqual({
      panels: [],
      activePanelId: null,
    });
    expect(selectActivePanel(nextState)).toBeNull();
  });

  it("no-ops when closing an unknown panel id", () => {
    const state: NewWorkspacePanelsState = {
      panels: [{ panelId: "term-1", kind: "terminal", terminalId: "term-1", createdAt: 1000 }],
      activePanelId: "term-1",
    };

    const nextState = panelsReducer(state, { type: "close", panelId: "unknown-id" });

    expect(nextState).toBe(state);
  });
});
