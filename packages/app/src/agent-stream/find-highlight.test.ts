/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionFindState } from "./find-in-session";
import {
  acquireSessionFindHighlightOwner,
  applySessionFindHighlights,
  clearSessionFindHighlights,
  releaseSessionFindHighlightOwner,
} from "./find-highlight";

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

let registry: Map<string, FakeHighlight>;
let containers: HTMLElement[];

function withGlobals(): void {
  registry = new Map();
  (globalThis as { CSS?: unknown }).CSS = { highlights: registry, escape: (v: string) => v };
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
}

/** Builds a stream container whose rows hold the given text nodes per item. */
function createContainer(rows: Array<{ itemId: string; textNodes: string[] }>): HTMLElement {
  const container = document.createElement("div");
  for (const row of rows) {
    const rowElement = document.createElement("div");
    rowElement.setAttribute("data-stream-item-id", row.itemId);
    for (const text of row.textNodes) {
      const span = document.createElement("span");
      span.textContent = text;
      rowElement.appendChild(span);
    }
    container.appendChild(rowElement);
  }
  document.body.appendChild(container);
  containers.push(container);
  return container;
}

function findState(overrides: Partial<SessionFindState> = {}): SessionFindState {
  return {
    query: "deploy",
    activeItemId: "first",
    activeOccurrenceIndex: 0,
    activeItemOccurrenceCount: 1,
    ...overrides,
  };
}

function rangeTexts(name: string): string[] {
  return (registry.get(name)?.ranges ?? []).map((range) => range.toString());
}

beforeEach(() => {
  containers = [];
  withGlobals();
});

afterEach(() => {
  for (const container of containers) {
    container.remove();
  }
  Reflect.deleteProperty(globalThis as { CSS?: unknown }, "CSS");
  Reflect.deleteProperty(globalThis as { Highlight?: unknown }, "Highlight");
  document.getElementById("paseo-session-find-highlight-style")?.remove();
});

describe("session find highlights", () => {
  it("registers match and active ranges under the owner's own names", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([
      { itemId: "first", textNodes: ["deploy the service"] },
      { itemId: "second", textNodes: ["deploy elsewhere"] },
    ]);

    applySessionFindHighlights({ owner, container, find: findState() });

    expect(rangeTexts(owner.activeName)).toEqual(["deploy"]);
    expect(rangeTexts(owner.matchName)).toEqual(["deploy"]);
    expect(owner.matchName).not.toBe(owner.activeName);
    releaseSessionFindHighlightOwner(owner);
  });

  // Retained tabs and split panes keep several viewports mounted; each one
  // re-runs its highlight pass whenever its own agent streams.
  it("keeps one viewport's highlights when another mounted viewport clears its own", () => {
    const searchingOwner = acquireSessionFindHighlightOwner();
    const backgroundOwner = acquireSessionFindHighlightOwner();
    const container = createContainer([{ itemId: "first", textNodes: ["deploy the service"] }]);

    applySessionFindHighlights({ owner: searchingOwner, container, find: findState() });
    expect(rangeTexts(searchingOwner.activeName)).toEqual(["deploy"]);

    // The background pane has no open find bar, so it clears its own slot.
    clearSessionFindHighlights(backgroundOwner);

    expect(rangeTexts(searchingOwner.activeName)).toEqual(["deploy"]);
    expect(registry.has(backgroundOwner.activeName)).toBe(false);

    releaseSessionFindHighlightOwner(searchingOwner);
    releaseSessionFindHighlightOwner(backgroundOwner);
  });

  it("lets two open find bars hold different ranges at once", () => {
    const left = acquireSessionFindHighlightOwner();
    const right = acquireSessionFindHighlightOwner();
    const leftContainer = createContainer([{ itemId: "first", textNodes: ["deploy the service"] }]);
    const rightContainer = createContainer([
      { itemId: "other", textNodes: ["restart the daemon"] },
    ]);

    applySessionFindHighlights({ owner: left, container: leftContainer, find: findState() });
    applySessionFindHighlights({
      owner: right,
      container: rightContainer,
      find: findState({ query: "restart", activeItemId: "other" }),
    });

    expect(rangeTexts(left.activeName)).toEqual(["deploy"]);
    expect(rangeTexts(right.activeName)).toEqual(["restart"]);

    releaseSessionFindHighlightOwner(left);
    releaseSessionFindHighlightOwner(right);
  });

  it("releases the highlight entries and reuses the slot", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([{ itemId: "first", textNodes: ["deploy the service"] }]);
    applySessionFindHighlights({ owner, container, find: findState() });

    releaseSessionFindHighlightOwner(owner);

    expect(registry.has(owner.matchName)).toBe(false);
    expect(registry.has(owner.activeName)).toBe(false);
    expect(acquireSessionFindHighlightOwner().slot).toBe(owner.slot);
  });

  it("emphasizes the requested occurrence when the row's occurrences line up", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([
      { itemId: "first", textNodes: ["deploy once, then deploy twice"] },
    ]);

    applySessionFindHighlights({
      owner,
      container,
      find: findState({ activeOccurrenceIndex: 1, activeItemOccurrenceCount: 2 }),
    });

    expect(registry.get(owner.activeName)?.ranges).toHaveLength(1);
    expect(registry.get(owner.matchName)?.ranges).toHaveLength(1);
    releaseSessionFindHighlightOwner(owner);
  });

  // Syntax highlighting splits a contiguous source string into one span per
  // token, so per-node matching would find nothing to highlight here.
  it("highlights an occurrence the renderer split across text nodes", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([
      { itemId: "first", textNodes: ["npm ", "run", " ", "typecheck"] },
    ]);

    applySessionFindHighlights({
      owner,
      container,
      find: findState({ query: "run typecheck" }),
    });

    expect(rangeTexts(owner.activeName)).toEqual(["run typecheck"]);
    releaseSessionFindHighlightOwner(owner);
  });

  it("keeps occurrence order when matches span node boundaries", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([
      { itemId: "first", textNodes: ["dep", "loy once, then de", "ploy twice"] },
    ]);

    applySessionFindHighlights({
      owner,
      container,
      find: findState({ activeOccurrenceIndex: 1, activeItemOccurrenceCount: 2 }),
    });

    // Both occurrences are found, so the ordinal is trusted: the second is active.
    expect(rangeTexts(owner.activeName)).toEqual(["deploy"]);
    expect(rangeTexts(owner.matchName)).toEqual(["deploy"]);
    releaseSessionFindHighlightOwner(owner);
  });

  // The model sees an item's source text; a row can still render extra text the
  // model never searched, so the ordinal cannot be trusted unconditionally.
  it("emphasizes every occurrence in the active row when the counts disagree", () => {
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([
      // Rendered chrome contributes an occurrence the match model never saw.
      { itemId: "first", textNodes: ["deploy", "deploy once"] },
    ]);

    applySessionFindHighlights({
      owner,
      container,
      find: findState({ activeOccurrenceIndex: 0, activeItemOccurrenceCount: 1 }),
    });

    expect(rangeTexts(owner.activeName)).toEqual(["deploy", "deploy"]);
    expect(registry.get(owner.matchName)?.ranges).toHaveLength(0);
    releaseSessionFindHighlightOwner(owner);
  });

  it("registers nothing and does not throw without the Custom Highlight API", () => {
    Reflect.deleteProperty(globalThis as { Highlight?: unknown }, "Highlight");
    const owner = acquireSessionFindHighlightOwner();
    const container = createContainer([{ itemId: "first", textNodes: ["deploy the service"] }]);

    expect(() => applySessionFindHighlights({ owner, container, find: findState() })).not.toThrow();
    expect(registry.size).toBe(0);
    releaseSessionFindHighlightOwner(owner);
  });
});
