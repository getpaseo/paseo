import { afterEach, describe, expect, it } from "vitest";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import type { FindResult } from "@/find/engine";
import type { FindHighlightContribution, FindHighlightRegistry } from "@/find/dom/highlights.web";
import type { StreamItem } from "@/types/stream";
import { createTranscriptFindEngine } from "./engine.web";
import type { TranscriptFindItem } from "./index";

const TIMESTAMP = new Date("2026-01-01T00:00:00.000Z");
const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: TIMESTAMP };
}

function assistantMessage(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: TIMESTAMP };
}

function loadedItems(...items: StreamItem[]): TranscriptFindItem[] {
  return items.map((item) => ({ item, isStreaming: false }));
}

interface FakeHighlights extends FindHighlightRegistry {
  contributions: Map<string, FindHighlightContribution>;
}

function fakeHighlights(): FakeHighlights {
  const contributions = new Map<string, FindHighlightContribution>();
  return {
    contributions,
    publish: (token, contribution) => {
      contributions.set(token, contribution);
    },
    release: (token) => {
      contributions.delete(token);
    },
    setColors: () => {},
  };
}

function published(highlights: FakeHighlights): FindHighlightContribution {
  const [only] = [...highlights.contributions.values()];
  expect(only).toBeDefined();
  return only as FindHighlightContribution;
}

function mountScroller(): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.height = "60px";
  scroller.style.overflow = "auto";
  document.body.append(scroller);
  mounted.push(scroller);
  return scroller;
}

/** A row as the web viewport renders it: the id on the row, the marker on its text. */
function appendRow(scroller: HTMLElement, id: string, text: string, marked = true): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-history-row-id", id);
  row.style.height = "40px";
  const content = document.createElement("span");
  if (marked) {
    content.setAttribute("data-paseo-find-text", "true");
  }
  content.textContent = text;
  const footer = document.createElement("span");
  footer.textContent = " needle in the footer";
  row.append(content, footer);
  scroller.append(row);
  return row;
}

/**
 * An assistant row the way message.tsx renders a mermaid fence followed by a paragraph:
 * one marked block per markdown block, and the fence's painted source marked unsearchable
 * because the projection scores a mermaid fence as empty text.
 */
function appendMermaidRow(scroller: HTMLElement, id: string): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-history-row-id", id);
  row.style.height = "40px";
  row.innerHTML = `
    <div data-paseo-find-text="true">
      <div data-paseo-find-ignore="true"><span>graph TD; A@{ img: "x" } alpha</span></div>
    </div>
    <div data-paseo-find-text="true"><span>alpha is here</span></div>
  `;
  scroller.append(row);
  return row;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

interface Harness {
  scroller: HTMLElement;
  highlights: FakeHighlights;
  revealed: string[];
  results: FindResult[];
  engine: ReturnType<typeof createTranscriptFindEngine>;
  setItems: (items: TranscriptFindItem[]) => void;
}

function setup(input: {
  items: TranscriptFindItem[];
  mount: (scroller: HTMLElement) => void;
  onReveal?: (itemId: string, scroller: HTMLElement) => void;
}): Harness {
  const scroller = mountScroller();
  input.mount(scroller);
  const highlights = fakeHighlights();
  const revealed: string[] = [];
  const results: FindResult[] = [];
  let items = input.items;

  const viewport: StreamViewportHandle = {
    scrollToBottom: () => {},
    prepareForViewportChange: () => {},
    getScrollElement: () => scroller,
    revealRow: (itemId) => {
      revealed.push(itemId);
      input.onReveal?.(itemId, scroller);
    },
  };

  const engine = createTranscriptFindEngine({
    getItems: () => items,
    getViewport: () => viewport,
    highlights,
  });
  engine.subscribe((result) => results.push(result));

  return {
    scroller,
    highlights,
    revealed,
    results,
    engine,
    setItems: (next) => {
      items = next;
    },
  };
}

describe("createTranscriptFindEngine", () => {
  it("counts from the loaded items, including rows with no DOM", () => {
    const harness = setup({
      items: loadedItems(
        userMessage("u1", "needle one"),
        userMessage("u2", "needle two"),
        userMessage("u3", "needle three"),
      ),
      mount: (scroller) => appendRow(scroller, "u3", "needle three"),
    });

    harness.engine.setQuery("needle");

    expect(harness.results.at(-1)?.count).toBe(3);
  });

  it("marks only the text inside the find markers, not the rest of the row", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one")),
      mount: (scroller) => appendRow(scroller, "u1", "needle one"),
    });

    harness.engine.setQuery("needle");

    const contribution = published(harness.highlights);
    expect(contribution.matches).toHaveLength(1);
    expect(contribution.active?.toString()).toBe("needle");
  });

  it("activates the first match at or after the top of the viewport", () => {
    const harness = setup({
      items: loadedItems(
        userMessage("u1", "needle one"),
        userMessage("u2", "needle two"),
        userMessage("u3", "needle three"),
      ),
      mount: (scroller) => {
        appendRow(scroller, "u1", "needle one");
        appendRow(scroller, "u2", "needle two");
        appendRow(scroller, "u3", "needle three");
      },
    });
    harness.scroller.scrollTop = 40;

    harness.engine.setQuery("needle");

    expect(harness.results.at(-1)?.activeIndex).toBe(1);
    expect(harness.revealed).toEqual(["u2"]);
  });

  it("steps forward and backward with wrap-around", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one"), userMessage("u2", "needle two")),
      mount: (scroller) => {
        appendRow(scroller, "u1", "needle one");
        appendRow(scroller, "u2", "needle two");
      },
    });

    harness.engine.setQuery("needle");
    expect(harness.results.at(-1)?.activeIndex).toBe(0);

    harness.engine.next();
    expect(harness.results.at(-1)?.activeIndex).toBe(1);

    harness.engine.next();
    expect(harness.results.at(-1)?.activeIndex).toBe(0);

    harness.engine.previous();
    expect(harness.results.at(-1)?.activeIndex).toBe(1);
  });

  it("waits for a revealed row to mount before marking its match", async () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one"), userMessage("u2", "needle two")),
      mount: (scroller) => appendRow(scroller, "u1", "needle one"),
      onReveal: (itemId, scroller) => {
        if (itemId === "u2") {
          requestAnimationFrame(() => appendRow(scroller, "u2", "needle two"));
        }
      },
    });

    harness.engine.setQuery("needle");
    harness.engine.next();
    expect(published(harness.highlights).active?.toString()).toBe("needle");

    await nextFrame();
    await nextFrame();

    const active = published(harness.highlights).active;
    expect(active?.startContainer.parentElement?.textContent).toBe("needle two");
  });

  it("moves on when the revealed row holds no range for the match", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one"), userMessage("u2", "needle two")),
      mount: (scroller) => {
        appendRow(scroller, "u1", "needle one", false);
        appendRow(scroller, "u2", "needle two");
      },
    });

    harness.engine.setQuery("needle");

    expect(harness.results.at(-1)?.activeIndex).toBe(1);
    expect(published(harness.highlights).active?.startContainer.textContent).toBe("needle two");
  });

  // The projection scores a mermaid fence as empty because only the DOM knows whether the
  // diagram or its source is painted; the DOM has to score it the same way.
  it("ignores the mermaid source the projection does not count", () => {
    const harness = setup({
      items: loadedItems(
        assistantMessage("a1", '```mermaid\ngraph TD; A@{ img: "x" } alpha\n```\n\nalpha is here'),
      ),
      mount: (scroller) => appendMermaidRow(scroller, "a1"),
    });

    harness.engine.setQuery("alpha");

    expect(harness.results.at(-1)).toEqual({ count: 1, activeIndex: 0 });
    const contribution = published(harness.highlights);
    expect(contribution.matches).toHaveLength(1);
    expect(contribution.active?.startContainer.textContent).toBe("alpha is here");
  });

  it("steps past an occurrence the row's DOM does not hold instead of marking another", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle needle"), userMessage("u2", "needle two")),
      mount: (scroller) => {
        appendRow(scroller, "u1", "needle");
        appendRow(scroller, "u2", "needle two");
      },
    });

    harness.engine.setQuery("needle");
    expect(harness.results.at(-1)).toEqual({ count: 3, activeIndex: 0 });

    harness.engine.next();

    expect(harness.results.at(-1)?.activeIndex).toBe(2);
    expect(published(harness.highlights).active?.startContainer.textContent).toBe("needle two");
  });

  it("keeps the active match when the loaded items grow underneath it", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one")),
      mount: (scroller) => appendRow(scroller, "u1", "needle one"),
    });

    harness.engine.setQuery("needle");
    expect(harness.results.at(-1)).toEqual({ count: 1, activeIndex: 0 });

    harness.setItems(
      loadedItems(userMessage("u0", "needle zero"), userMessage("u1", "needle one")),
    );
    harness.engine.refreshItems();

    expect(harness.results.at(-1)).toEqual({ count: 2, activeIndex: 1 });
  });

  it("re-marks a row whose text changed under an open query", async () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one")),
      mount: (scroller) => appendRow(scroller, "u1", "needle one"),
    });

    harness.engine.setQuery("needle");
    expect(published(harness.highlights).matches).toHaveLength(1);

    const marked = harness.scroller.querySelector("[data-paseo-find-text]");
    if (!(marked instanceof HTMLElement)) {
      throw new Error("expected a marked subtree");
    }
    marked.textContent = "needle needle";
    await nextFrame();
    await nextFrame();

    expect(published(harness.highlights).matches.length).toBeGreaterThan(1);
  });

  it("drops its highlights and its count when cleared", () => {
    const harness = setup({
      items: loadedItems(userMessage("u1", "needle one")),
      mount: (scroller) => appendRow(scroller, "u1", "needle one"),
    });

    harness.engine.setQuery("needle");
    harness.engine.clear();

    expect(harness.highlights.contributions.size).toBe(0);
    expect(harness.results.at(-1)).toEqual({ count: 0, activeIndex: null });
  });
});
