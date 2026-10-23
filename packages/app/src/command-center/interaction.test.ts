import { describe, expect, it } from "vitest";
import { createCommandCenterInteraction } from "./interaction";
import { projectCommandCenterRows, type CommandCenterFileResult } from "./results";
import type { CommandCenterScope } from "@/stores/keyboard-shortcuts-store";

function results(ids = ["a", "b", "c", "d"]) {
  return projectCommandCenterRows(
    [
      {
        id: "files",
        band: 0,
        rank: 0,
        title: "Files",
        results: ids.map<CommandCenterFileResult>((id) => ({
          id,
          kind: "file",
          filePath: id,
          title: id,
          subtitle: "",
          run() {},
        })),
      },
    ],
    { singleLineRow: 40, twoLineRow: 60, sectionTitle: 20, sectionDivider: 10 },
  );
}

function setup(options: { scope?: CommandCenterScope; measured?: boolean } = {}) {
  const offsets: number[] = [];
  const model = createCommandCenterInteraction((offset) => offsets.push(offset));
  const publish = (ids = ["a", "b", "c", "d"], loading = false) =>
    model.update({
      open: true,
      scope: options.scope ?? null,
      query: model.getSnapshot().query,
      projection: results(ids),
      loading,
    });
  publish();
  if (options.measured !== false) model.layout(80);
  return { model, offsets, publish };
}

describe("Command Center interaction", () => {
  it("keeps manual scrolling through result refresh, removal, and resizing", () => {
    const { model, offsets, publish } = setup();
    model.beginManualScroll();
    model.scrolled(100);
    publish();
    publish(["b", "c", "d"]);
    model.layout(60);
    expect(model.getSnapshot().activeId).toBe("b");
    expect(offsets).toEqual([]);
  });

  it("reveals only clipped keyboard selections and wraps around", () => {
    const { model, offsets } = setup();
    expect(model.move("next")).toBe(true);
    expect(offsets).toEqual([20]);
    model.scrolled(20); // The programmatic scroll callback is only a measurement.
    model.move("next");
    expect(offsets).toEqual([20, 60]);
    model.move("previous");
    expect(offsets).toEqual([20, 60]);
    model.move("previous");
    expect(offsets).toEqual([20, 60, 20]);
    model.move("previous");
    expect(model.getSnapshot().activeId).toBe("d");
    expect(offsets).toEqual([20, 60, 20, 100]);
  });

  it("keyboard navigation takes control again after manual scrolling", () => {
    const { model, offsets } = setup();
    model.beginManualScroll();
    model.scrolled(100);
    model.move("next");
    expect(model.getSnapshot().activeId).toBe("b");
    expect(offsets).toEqual([60]);
  });

  it("a new query reveals even when the active ID stays the same", () => {
    const { model, offsets, publish } = setup();
    model.scrolled(100);
    model.setQuery("a");
    expect(offsets).toEqual([]);
    publish(["a", "b"]);
    expect(model.getSnapshot()).toEqual({ query: "a", activeId: "a" });
    expect(offsets).toEqual([20]);
    model.scrolled(100);
    publish(["a", "b"]);
    expect(offsets).toEqual([20]);
  });

  it("an arrow command reveals a single result even when its ID cannot change", () => {
    const { model, offsets, publish } = setup();
    publish(["a"]);
    model.scrolled(30);
    model.move("next");
    expect(offsets).toEqual([20]);
  });

  it("defers reveals until layout exists and consumes them only once", () => {
    const { model, offsets, publish } = setup({ measured: false });
    model.move("previous");
    expect(offsets).toEqual([]);
    model.layout(80);
    expect(offsets).toEqual([100]);
    model.scrolled(0);
    publish();
    model.layout(60);
    expect(offsets).toEqual([100]);
  });

  it("manual interaction cancels an unmeasured request", () => {
    const { model, offsets } = setup({ measured: false });
    model.move("previous");
    model.beginManualScroll();
    model.layout(80);
    expect(offsets).toEqual([]);
  });

  it("waits for scoped search results instead of revealing the previous query's rows", () => {
    const { model, offsets, publish } = setup({ scope: "files" });
    model.scrolled(100);
    model.setQuery("new");
    publish(["a", "b"], true);
    expect(offsets).toEqual([]);
    expect(model.getSnapshot().activeId).toBeNull();
    publish(["b", "a"]);
    expect(model.getSnapshot().activeId).toBe("b");
    expect(offsets).toEqual([20]);
  });

  it("manual interaction cancels a reveal awaiting search results", () => {
    const { model, offsets, publish } = setup({ scope: "files" });
    model.setQuery("new");
    publish([], true);
    model.beginManualScroll();
    model.scrolled(100);
    publish(["new"]);
    expect(model.getSnapshot().activeId).toBe("new");
    expect(offsets).toEqual([]);
  });

  it("empty searches complete without granting future passive results permission to scroll", () => {
    const { model, offsets, publish } = setup();
    model.setQuery("missing");
    publish([]);
    expect(model.move("next")).toBe(false);
    expect(model.getSnapshot().activeId).toBeNull();
    model.scrolled(100);
    publish(["late"]);
    expect(offsets).toEqual([]);
  });

  it("scope changes reset selection and request a reveal", () => {
    const { model, offsets } = setup();
    model.move("next");
    model.scrolled(100);
    model.update({ open: true, scope: "files", query: "", projection: results(), loading: false });
    expect(model.getSnapshot().activeId).toBe("a");
    expect(offsets).toEqual([20, 20]);
  });

  it("close discards the old query, metrics, and deferred reveal", () => {
    const { model, offsets, publish } = setup({ measured: false });
    model.setQuery("old");
    publish();
    model.move("previous");
    model.update({ open: false, scope: null, query: "old", projection: results(), loading: false });
    model.layout(80);
    expect(model.getSnapshot()).toEqual({ query: "", activeId: null });
    expect(offsets).toEqual([]);
    publish();
    expect(model.getSnapshot().activeId).toBe("a");
    expect(offsets).toEqual([]);
  });
});
