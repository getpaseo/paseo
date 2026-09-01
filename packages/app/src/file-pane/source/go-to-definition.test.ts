// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { goToDefinition } from "./go-to-definition.web";
import type { DefinitionTarget } from "./go-to-definition";

// Unistyles reads matchMedia when it is imported, reached here through the shared macOS check,
// and jsdom does not implement it. Hoisted so it lands before the module graph is evaluated.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

// jsdom has no layout, so CodeMirror's own default mousedown handler throws when it measures
// text. Our handler declines plain clicks and lets that default run, which is the behavior under
// test; the shim keeps the environment from failing the run.
Range.prototype.getClientRects = () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const DOC = [
  'import { SessionsScreen } from "@/screens/sessions-screen";',
  "",
  "const x = 1;",
].join("\n");

/** `SessionsScreen` on line 1 (0-based), characters 9..23 — the case from the file viewer. */
const SYMBOL_RANGE = {
  start: { line: 0, character: 9 },
  end: { line: 0, character: 23 },
};

function createView(callbacks: {
  resolve: (position: { line: number; character: number }) => Promise<{
    originRange?: typeof SYMBOL_RANGE;
    target: DefinitionTarget;
  } | null>;
  navigate: (target: DefinitionTarget) => void;
}) {
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [goToDefinition(callbacks)] }),
  });
  // jsdom lays out nothing, so map coordinates to the symbol's offset directly.
  vi.spyOn(view, "posAtCoords").mockImplementation(() => 12);
  return view;
}

function mouseEvent(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { clientX: 40, clientY: 8, bubbles: true, ...init });
}

function decorationRanges(view: EditorView): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const cursor = set.iter();
    while (cursor.value) {
      ranges.push({ from: cursor.from, to: cursor.to });
      cursor.next();
    }
  }
  return ranges;
}

describe("goToDefinition", () => {
  it("navigates on modifier + click and reports a zero-based position", async () => {
    const navigate = vi.fn();
    const resolve = vi.fn().mockResolvedValue({
      originRange: SYMBOL_RANGE,
      target: { path: "src/screens/sessions-screen.tsx", line: 62 },
    });
    const view = createView({ resolve, navigate });

    view.contentDOM.dispatchEvent(mouseEvent("mousedown", { metaKey: true, ctrlKey: true }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));

    // Asked at the word start, not where the pointer landed, so every point inside a symbol
    // is one cache entry and one request.
    expect(resolve).toHaveBeenCalledWith({ line: 0, character: 9 });
    expect(navigate).toHaveBeenCalledWith({
      path: "src/screens/sessions-screen.tsx",
      line: 62,
    });
    view.destroy();
  });

  it("stays inert on a plain click so normal interaction is untouched", () => {
    const navigate = vi.fn();
    const resolve = vi.fn().mockResolvedValue(null);
    const view = createView({ resolve, navigate });

    view.contentDOM.dispatchEvent(mouseEvent("mousedown"));

    expect(resolve).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    view.destroy();
  });

  it("underlines the word before the daemon answers", async () => {
    let settle: (value: unknown) => void = () => {};
    const resolve = vi.fn().mockReturnValue(new Promise((r) => (settle = r)));
    const view = createView({ resolve, navigate: vi.fn() });

    view.contentDOM.dispatchEvent(mouseEvent("mousemove", { metaKey: true, ctrlKey: true }));

    // Underlined synchronously, with the request still in flight.
    expect(decorationRanges(view)).toContainEqual({ from: 9, to: 23 });
    settle(null);
    view.destroy();
  });

  it("drops the underline when the word resolves to nothing", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const view = createView({ resolve, navigate: vi.fn() });

    view.contentDOM.dispatchEvent(mouseEvent("mousemove", { metaKey: true, ctrlKey: true }));
    await vi.waitFor(() => expect(decorationRanges(view)).toEqual([]));
    view.destroy();
  });

  it("asks once per word and serves repeat hovers from cache", async () => {
    const resolve = vi.fn().mockResolvedValue({
      originRange: SYMBOL_RANGE,
      target: { path: "src/screens/sessions-screen.tsx", line: 62 },
    });
    const view = createView({ resolve, navigate: vi.fn() });
    const hover = () =>
      view.contentDOM.dispatchEvent(mouseEvent("mousemove", { metaKey: true, ctrlKey: true }));

    hover();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    view.contentDOM.dispatchEvent(mouseEvent("mouseleave"));
    hover();
    view.contentDOM.dispatchEvent(mouseEvent("mousedown", { metaKey: true, ctrlKey: true }));

    await vi.waitFor(() => expect(decorationRanges(view)).toEqual([]));
    expect(resolve).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("underlines the range the server reported, not a guess at the symbol", async () => {
    const resolve = vi.fn().mockResolvedValue({
      originRange: SYMBOL_RANGE,
      target: { path: "src/screens/sessions-screen.tsx", line: 62 },
    });
    const view = createView({ resolve, navigate: vi.fn() });

    view.contentDOM.dispatchEvent(mouseEvent("mousemove", { metaKey: true, ctrlKey: true }));
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());

    // Offsets 9..23 on the first line: exactly `SessionsScreen`.
    await vi.waitFor(() => expect(decorationRanges(view)).toContainEqual({ from: 9, to: 23 }));
    view.destroy();
  });
});
