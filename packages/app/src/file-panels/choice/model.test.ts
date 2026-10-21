import { describe, expect, it } from "vitest";
import { filePanelCatalog, sourceFilePanel } from "../catalog";
import { resolveFilePanel, type FilePanelCandidate } from "../resolve";
import { chosenPanelFor, FilePanelChoiceModel } from "./model";

const rich: FilePanelCandidate = {
  id: "plugin:notes/rich",
  builtin: false,
  files: { extensions: ["md", "markdown"] },
};
const markdown = "builtin:markdown";
const source = sourceFilePanel.id;

/** A file tab: resolves against the shared associations and feeds the result to its model. */
function openTab(
  associations: Record<string, string>,
  candidates: FilePanelCandidate[] = [...filePanelCatalog([rich])],
  options: { presentable?: boolean; path?: string; lineNavigation?: number | null } = {},
) {
  const model = new FilePanelChoiceModel<FilePanelCandidate>({
    remember(selectorKey, panelId) {
      if (panelId === null) delete associations[selectorKey];
      else associations[selectorKey] = panelId;
    },
    linePanelId: source,
  });
  let targetKey = `/repo:${options.path ?? "notes.md"}`;
  let presentable = options.presentable ?? true;
  let lineNavigation = options.lineNavigation ?? null;
  const resolve = () =>
    resolveFilePanel({
      file: { path: targetKey.split(":")[1]!, kind: "text" },
      candidates,
      associations,
      choice: chosenPanelFor(model.getSnapshot(), targetKey),
    });
  // Like the hook: observe, then render what the model's choice resolves to.
  const render = () => {
    model.observe({ targetKey, resolution: resolve(), presentable, lineNavigation });
    return resolve().panel?.id ?? null;
  };
  render();
  return {
    model,
    render,
    panel: () => render(),
    picker: () => model.getSnapshot().picker,
    retarget(path: string) {
      targetKey = `/repo:${path}`;
      return render();
    },
    setPresentable(next: boolean) {
      presentable = next;
      return render();
    },
    navigateToLine(revision: number) {
      lineNavigation = revision;
      return render();
    },
  };
}

describe("FilePanelChoiceModel", () => {
  it("asks once per tab open over the first candidate, and dismissing keeps it", () => {
    const associations = {};
    const tab = openTab(associations);
    expect(tab.panel()).toBe(markdown);
    expect(tab.picker()).toMatchObject({
      selectorKey: "ext:md",
      selectedPanelId: markdown,
      remember: false,
    });
    expect(tab.picker()?.candidates.map((candidate) => candidate.id)).toEqual([
      markdown,
      rich.id,
      source,
    ]);
    tab.model.dismissPicker();
    expect(tab.picker()).toBeNull();
    expect(tab.panel()).toBe(markdown);
    expect(tab.picker()).toBeNull();
    expect(associations).toEqual({});

    expect(openTab(associations).picker()).not.toBeNull();
  });

  it("never asks between built-in panels, and switches between them", () => {
    const tab = openTab({}, [...filePanelCatalog([])]);
    expect(tab.panel()).toBe(markdown);
    expect(tab.picker()).toBeNull();
    expect(tab.model.getSnapshot().openWith?.candidates.map((candidate) => candidate.id)).toEqual([
      markdown,
      source,
    ]);
    tab.model.openWith(source);
    expect(tab.panel()).toBe(source);
    expect(tab.picker()).toBeNull();
  });

  it("opens a file only Source claims with Source and nothing to choose", () => {
    const tab = openTab({}, [...filePanelCatalog([rich])], { path: "index.ts" });
    expect(tab.panel()).toBe(source);
    expect(tab.picker()).toBeNull();
    expect(tab.model.getSnapshot().openWith).toBeNull();
  });

  it("remembers the choice when Don't ask me again is checked", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.setRemember(true);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({ "ext:md": rich.id });

    const next = openTab(associations);
    expect(next.panel()).toBe(rich.id);
    expect(next.picker()).toBeNull();
  });

  it("uses an unremembered choice for this tab only and asks again on the next open", () => {
    const associations = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({});

    const next = openTab(associations);
    expect(next.panel()).toBe(markdown);
    expect(next.picker()).not.toBeNull();
  });

  it("does not ask with an association or while the tab is in the background", () => {
    expect(openTab({ "ext:md": rich.id }).picker()).toBeNull();
    expect(openTab({ "ext:md": source }).panel()).toBe(source);

    const background = openTab({}, undefined, { presentable: false });
    expect(background.picker()).toBeNull();
    background.setPresentable(true);
    expect(background.picker()).not.toBeNull();
  });

  it("opens Source for a line target without asking, and again on each new one", () => {
    const tab = openTab({}, undefined, { lineNavigation: 1 });
    expect(tab.panel()).toBe(source);
    expect(tab.picker()).toBeNull();

    tab.model.openWith(rich.id);
    expect(tab.panel()).toBe(rich.id);
    expect(tab.navigateToLine(1)).toBe(rich.id);
    expect(tab.navigateToLine(2)).toBe(source);
  });

  it("opens Source for the same line target in a retargeted tab", () => {
    const tab = openTab({}, undefined, { lineNavigation: 1 });
    tab.model.openWith(markdown);
    expect(tab.retarget("other.md")).toBe(source);
  });

  it("starts a new open when the tab is retargeted", () => {
    const tab = openTab({});
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.retarget("other.md")).toBe(markdown);
    expect(tab.picker()).not.toBeNull();
  });

  it("switches with Open with and toggles Always use without moving the tab", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.dismissPicker();
    expect(tab.model.getSnapshot().openWith).toMatchObject({
      activePanelId: markdown,
      remembered: false,
    });

    tab.model.openWith(rich.id);
    expect(tab.panel()).toBe(rich.id);
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({ "ext:md": rich.id });
    tab.render();
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(true);

    tab.model.openWith(markdown);
    expect(tab.panel()).toBe(markdown);
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(false);
    tab.model.openWith(rich.id);
    tab.render();
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({});
    expect(tab.panel()).toBe(rich.id);
  });

  it("asks when a plugin panel arrives after the file first rendered", () => {
    const candidates: FilePanelCandidate[] = [...filePanelCatalog([])];
    const tab = openTab({}, candidates);
    expect(tab.picker()).toBeNull();
    candidates.splice(1, 0, rich);
    tab.render();
    expect(tab.picker()).not.toBeNull();
  });
});
