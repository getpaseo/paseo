import { describe, expect, it } from "vitest";
import {
  finishExplorerSidebarResize,
  reconcileExplorerSidebarResize,
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarFrameWidth,
  resolveExplorerSidebarWidth,
  type ExplorerSidebarResize,
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
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1200 })).toBe(840);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 600, containerWidth: 750 })).toBe(390);
  });

  describe("native resize ownership", () => {
    const allocation = {
      width: 320,
      containerWidth: 1200,
      overlay: false,
      resizeEnabled: true,
    };
    const dragging: ExplorerSidebarResize = {
      sourceWidth: allocation.width,
      containerWidth: allocation.containerWidth,
      pendingWidth: null,
    };

    it("keeps the drag width after release while the JS commit still has the old prop", () => {
      expect(
        resolveExplorerSidebarFrameWidth({ ...allocation, resize: dragging, resizeWidth: 480 }),
      ).toBe(480);

      const released = finishExplorerSidebarResize(dragging, 480, true);
      expect(reconcileExplorerSidebarResize(released, allocation)).toBe(released);
      expect(
        resolveExplorerSidebarFrameWidth({ ...allocation, resize: released, resizeWidth: 480 }),
      ).toBe(480);
      expect(
        resolveExplorerSidebarFrameWidth({ ...allocation, resize: released, resizeWidth: 320 }),
      ).toBe(480);
    });

    it("acknowledges the committed width and immediately follows subsequent props", () => {
      const released = finishExplorerSidebarResize(dragging, 480, true);
      const acknowledgedAllocation = { ...allocation, width: 480 };
      expect(
        resolveExplorerSidebarFrameWidth({
          ...acknowledgedAllocation,
          resize: released,
          resizeWidth: 480,
        }),
      ).toBe(480);
      const acknowledged = reconcileExplorerSidebarResize(released, acknowledgedAllocation);
      expect(acknowledged).toBeNull();
      expect(
        resolveExplorerSidebarFrameWidth({
          ...allocation,
          width: 360,
          resize: acknowledged,
          resizeWidth: 480,
        }),
      ).toBe(360);
    });

    it.each([
      { name: "a new width prop", next: { ...allocation, width: 360 }, expected: 360 },
      {
        name: "a window allocation with an unchanged width prop",
        next: { ...allocation, containerWidth: 900 },
        expected: 320,
      },
      {
        name: "a window allocation that clamps the width prop",
        next: { ...allocation, width: 540, containerWidth: 900 },
        expected: 540,
      },
      { name: "overlay presentation", next: { ...allocation, overlay: true }, expected: 1200 },
      { name: "an inactive dock", next: { ...allocation, resizeEnabled: false }, expected: 320 },
    ])(
      "yields synchronously to $name and does not resurrect the old handoff",
      ({ next, expected }) => {
        const released = finishExplorerSidebarResize(dragging, 600, true);
        expect(
          resolveExplorerSidebarFrameWidth({ ...next, resize: released, resizeWidth: 600 }),
        ).toBe(expected);
        const interrupted = reconcileExplorerSidebarResize(released, next);
        expect(interrupted).toBeNull();
        expect(
          resolveExplorerSidebarFrameWidth({
            ...allocation,
            resize: interrupted,
            resizeWidth: 600,
          }),
        ).toBe(320);
      },
    );

    it("restores canonical intent when a drag is canceled", () => {
      const canceled = finishExplorerSidebarResize(dragging, 480, false);
      expect(canceled).toBeNull();
      expect(
        resolveExplorerSidebarFrameWidth({ ...allocation, resize: canceled, resizeWidth: 480 }),
      ).toBe(320);
    });

    it("cannot finish an interrupted drag over a newer allocation", () => {
      const next = { ...allocation, width: 360, containerWidth: 1000 };
      const interrupted = reconcileExplorerSidebarResize(dragging, next);
      const released = finishExplorerSidebarResize(interrupted, 480, true);
      expect(released).toBeNull();
      expect(
        resolveExplorerSidebarFrameWidth({ ...next, resize: released, resizeWidth: 480 }),
      ).toBe(360);
    });

    it("settles a release at the already-committed width without retaining ownership", () => {
      const released = finishExplorerSidebarResize(dragging, allocation.width, true);
      expect(reconcileExplorerSidebarResize(released, allocation)).toBeNull();
    });

    it("keeps an earlier released handoff when a later touch fails before activation", () => {
      const released = finishExplorerSidebarResize(dragging, 480, true);
      const finalized = finishExplorerSidebarResize(released, 480, false);
      expect(finalized).toBe(released);
      expect(
        resolveExplorerSidebarFrameWidth({ ...allocation, resize: finalized, resizeWidth: 480 }),
      ).toBe(480);
    });
  });
});
