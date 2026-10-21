import { describe, expect, it } from "vitest";
import type { FilePanelOpenWithState } from "./model";
import { filePanelSwitcherState } from "./switcher-layout";

function openWith(count: number): FilePanelOpenWithState<{ id: string }> {
  const candidates = Array.from({ length: count }, (_, index) => ({ id: `panel-${index}` }));
  return { selectorKey: "ext:md", candidates, activePanelId: "panel-1", remembered: false };
}

describe("filePanelSwitcherState", () => {
  it("shows nothing when the file has one panel or none", () => {
    expect(filePanelSwitcherState(null, { compact: false })).toBeNull();
  });

  it("sets up to three panels side by side and more behind a menu", () => {
    const wide = { compact: false };
    expect(filePanelSwitcherState(openWith(2), wide)?.layout).toBe("segmented");
    expect(filePanelSwitcherState(openWith(3), wide)?.layout).toBe("segmented");
    expect(filePanelSwitcherState(openWith(4), wide)).toMatchObject({
      layout: "menu",
      activePanelId: "panel-1",
      candidates: openWith(4).candidates,
    });
  });

  it("sets two panels side by side on a compact screen and more behind a menu", () => {
    const compact = { compact: true };
    expect(filePanelSwitcherState(openWith(2), compact)?.layout).toBe("segmented");
    expect(filePanelSwitcherState(openWith(3), compact)?.layout).toBe("menu");
  });
});
