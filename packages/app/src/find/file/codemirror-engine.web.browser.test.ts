import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorSearchExtension } from "@/file-pane/editor/extensions.web";
import type { FindResult } from "@/find/engine";
import { createCodeMirrorFindEngine } from "./codemirror-engine.web";

// "alpha" at 0, "Alpha" at 11, "alpha" at 23.
const DOC = "alpha beta Alpha gamma alpha";

const views: EditorView[] = [];

function setup(doc = DOC) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [editorSearchExtension()] }),
  });
  views.push(view);
  const engine = createCodeMirrorFindEngine(view);
  let result: FindResult = { count: 0, activeIndex: null };
  engine.subscribe((next) => {
    result = next;
  });
  return { view, engine, current: () => result };
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

describe("createCodeMirrorFindEngine", () => {
  it("counts matches case-insensitively and activates the first one", () => {
    const { engine, current, view } = setup();

    engine.setQuery("alpha");

    expect(current()).toEqual({ count: 3, activeIndex: 0 });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
  });

  it("steps forward and wraps at the end", () => {
    const { engine, current } = setup();
    engine.setQuery("alpha");

    engine.next();
    expect(current().activeIndex).toBe(1);
    engine.next();
    expect(current().activeIndex).toBe(2);
    engine.next();
    expect(current().activeIndex).toBe(0);
  });

  it("steps backward and wraps at the start", () => {
    const { engine, current } = setup();
    engine.setQuery("alpha");

    engine.previous();

    expect(current().activeIndex).toBe(2);
  });

  it("reports no matches without moving the selection", () => {
    const { engine, current, view } = setup();

    engine.setQuery("delta");

    expect(current()).toEqual({ count: 0, activeIndex: null });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 0 });
  });

  it("marks every visible match and distinguishes the active one", async () => {
    const { engine, view } = setup();

    engine.setQuery("alpha");
    await nextFrame();

    expect(view.dom.querySelectorAll(".cm-paseoFindMatch")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-paseoFindMatchActive")).toHaveLength(1);
  });

  it("drops the marks and the count when cleared", async () => {
    const { engine, current, view } = setup();
    engine.setQuery("alpha");
    await nextFrame();

    engine.clear();
    await nextFrame();

    expect(current()).toEqual({ count: 0, activeIndex: null });
    expect(view.dom.querySelectorAll(".cm-paseoFindMatch")).toHaveLength(0);
  });

  // A find selection left behind becomes a live document selection once focus returns
  // to the editor, and react-native-web then swallows the next press anywhere.
  it("collapses the selection it made when cleared", () => {
    const { engine, view } = setup();
    engine.setQuery("alpha");
    engine.next();
    expect(view.state.selection.main).toMatchObject({ from: 11, to: 16 });

    engine.clear();

    expect(view.state.selection.main).toMatchObject({ from: 11, to: 11 });
  });

  it("leaves a selection the user made alone when cleared", () => {
    const { engine, view } = setup();
    engine.setQuery("alpha");
    view.dispatch({ selection: { anchor: 6, head: 10 } });

    engine.clear();

    expect(view.state.selection.main).toMatchObject({ from: 6, to: 10 });
  });

  // `findNext` answers an invalid query by opening CodeMirror's own search panel,
  // which would put a second, unstyled find UI inside the pane.
  it("never opens CodeMirror's own search panel", () => {
    const { engine, view } = setup();

    engine.setQuery("");
    engine.next();
    engine.previous();

    expect(view.dom.querySelector(".cm-panel")).toBeNull();
  });

  it("keeps the match under the cursor while the query grows", () => {
    const { engine, current, view } = setup();

    for (const prefix of ["a", "al", "alp", "alph", "alpha"]) {
      engine.setQuery(prefix);
    }

    expect(current()).toEqual({ count: 3, activeIndex: 0 });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
  });

  it("keeps the match under the cursor while the query shrinks", () => {
    const { engine, current, view } = setup();

    engine.setQuery("alpha");
    engine.setQuery("alph");
    engine.setQuery("a");

    expect(current()).toEqual({ count: 9, activeIndex: 0 });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 1 });
  });

  it("activates the occurrence the editor selection covers, not the one after it", () => {
    const { engine, current, view } = setup();
    view.dispatch({ selection: { anchor: 11, head: 16 } });

    engine.setQuery("alpha");

    expect(current()).toEqual({ count: 3, activeIndex: 1 });
    expect(view.state.selection.main).toMatchObject({ from: 11, to: 16 });
  });

  // `findNext` re-anchors its own cursor at the selection and can land on a match the
  // counting pass skipped as overlapping, leaving the caret on an uncounted range.
  it("never activates a match the count does not include", async () => {
    const { engine, current, view } = setup("a === b");

    engine.setQuery("=");
    engine.setQuery("==");
    await nextFrame();

    expect(current()).toEqual({ count: 1, activeIndex: 0 });
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 4 });
    expect(view.dom.querySelectorAll(".cm-paseoFindMatchActive")).toHaveLength(1);
  });

  it("stops reporting once disposed", () => {
    const { engine, current, view } = setup();
    engine.setQuery("alpha");

    engine.dispose();
    view.dispatch({ selection: { anchor: 23, head: 28 } });

    expect(current()).toEqual({ count: 3, activeIndex: 0 });
  });
});
