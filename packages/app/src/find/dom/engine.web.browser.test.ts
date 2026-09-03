import { afterEach, describe, expect, it } from "vitest";
import type { FindResult } from "@/find/engine";
import { createDomFindEngine } from "./engine.web";
import type { FindHighlightContribution, FindHighlightRegistry } from "./highlights.web";

const mounted: HTMLElement[] = [];

function mountScroller(html: string): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.height = "100px";
  scroller.style.overflow = "auto";
  scroller.innerHTML = html;
  document.body.append(scroller);
  mounted.push(scroller);
  return scroller;
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

function only(highlights: FakeHighlights): FindHighlightContribution {
  const [contribution] = [...highlights.contributions.values()];
  expect(contribution).toBeDefined();
  return contribution as FindHighlightContribution;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("createDomFindEngine", () => {
  function setup(html: string) {
    const scroller = mountScroller(html);
    const highlights = fakeHighlights();
    const results: FindResult[] = [];
    const engine = createDomFindEngine({
      getRoots: () => [scroller],
      getScrollElement: () => scroller,
      highlights,
    });
    engine.subscribe((result) => results.push(result));
    return { engine, highlights, results, scroller };
  }

  it("emits the current result the moment a listener subscribes", () => {
    const { results } = setup("<p>alpha</p>");

    expect(results).toEqual([{ count: 0, activeIndex: null }]);
  });

  it("counts every occurrence and activates the first one", () => {
    const { engine, results } = setup("<p>alpha</p><p>alpha beta alpha</p>");

    engine.setQuery("alpha");

    expect(results.at(-1)).toEqual({ count: 3, activeIndex: 0 });
  });

  it("wraps around at both ends", () => {
    const { engine, results } = setup("<p>alpha</p><p>alpha</p>");
    engine.setQuery("alpha");

    engine.next();
    expect(results.at(-1)?.activeIndex).toBe(1);
    engine.next();
    expect(results.at(-1)?.activeIndex).toBe(0);
    engine.previous();
    expect(results.at(-1)?.activeIndex).toBe(1);
  });

  it("starts from the first match at or below the top of the visible area", () => {
    const rows = Array.from({ length: 5 }, () => '<p style="height: 200px">alpha</p>').join("");
    const { engine, results, scroller } = setup(rows);
    scroller.scrollTop = 400;

    engine.setQuery("alpha");

    expect(results.at(-1)).toEqual({ count: 5, activeIndex: 2 });
  });

  it("keeps the active range out of the plain-match set so it paints on its own", () => {
    const { engine, highlights } = setup("<p>alpha</p><p>alpha</p>");

    engine.setQuery("alpha");

    const contribution = only(highlights);
    expect(contribution.matches).toHaveLength(2);
    expect(contribution.active).toBe(contribution.matches[0]);
  });

  it("drops highlights and reports nothing once the query is emptied", () => {
    const { engine, highlights, results } = setup("<p>alpha</p>");
    engine.setQuery("alpha");

    engine.setQuery("");

    expect(results.at(-1)).toEqual({ count: 0, activeIndex: null });
    expect(only(highlights).matches).toHaveLength(0);
  });

  it("releases its highlights on clear", () => {
    const { engine, highlights, results } = setup("<p>alpha</p>");
    engine.setQuery("alpha");

    engine.clear();

    expect(results.at(-1)).toEqual({ count: 0, activeIndex: null });
    expect(highlights.contributions.size).toBe(0);
  });

  it("re-counts after the searched DOM changes", async () => {
    const { engine, results, scroller } = setup("<p>alpha</p>");
    engine.setQuery("alpha");

    scroller.append(document.createRange().createContextualFragment("<p>alpha</p>"));
    await nextFrame();
    await nextFrame();

    expect(results.at(-1)?.count).toBe(2);
  });

  it("stops recomputing once disposed", async () => {
    const { engine, highlights, results, scroller } = setup("<p>alpha</p>");
    engine.setQuery("alpha");
    const emitted = results.length;

    engine.dispose();
    scroller.append(document.createRange().createContextualFragment("<p>alpha</p>"));
    await nextFrame();
    await nextFrame();

    expect(results).toHaveLength(emitted);
    expect(highlights.contributions.size).toBe(0);
  });
});
