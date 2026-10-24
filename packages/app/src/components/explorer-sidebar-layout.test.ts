import { describe, expect, it } from "vitest";
import {
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";

describe("Explorer sidebar layout", () => {
  it("keeps the sidebar width fixed when the workspace body changes size", () => {
    const narrow = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1200 });
    const wide = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1520 });

    expect(narrow[1] * 1200).toBeCloseTo(320);
    expect(wide[1] * 1520).toBeCloseTo(320);
  });

  it("has no fixed maximum while preserving room for the workspace body", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: 100, containerWidth: 1200 })).toBe(240);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1600 })).toBe(900);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1200 })).toBe(800);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 600, containerWidth: 750 })).toBe(350);
  });

  it.each([
    { containerWidth: 600, explorerWidth: 240, bodyWidth: 360 },
    { containerWidth: 639, explorerWidth: 240, bodyWidth: 399 },
    { containerWidth: 640, explorerWidth: 240, bodyWidth: 400 },
    { containerWidth: 720, explorerWidth: 320, bodyWidth: 400 },
  ])(
    "keeps the Explorer floor in a $containerWidth dp shell",
    ({ containerWidth, explorerWidth, bodyWidth }) => {
      expect(resolveExplorerSidebarWidth({ containerWidth })).toBe(explorerWidth);
      const [body, explorer] = resolveExplorerSidebarDockSizes({ containerWidth });
      expect(body * containerWidth).toBeCloseTo(bodyWidth);
      expect(explorer * containerWidth).toBeCloseTo(explorerWidth);
    },
  );
});
