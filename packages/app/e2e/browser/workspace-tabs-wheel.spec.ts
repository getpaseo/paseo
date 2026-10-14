import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test("vertical wheel scrolls overflowing workspace tabs horizontally", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "workspace-tabs-wheel-" });

  try {
    await page.setViewportSize({ width: 1100, height: 760 });
    for (let index = 0; index < 8; index += 1) {
      await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `Wheel tab ${index + 1}`,
      });
    }

    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    const scroll = page.getByTestId("workspace-tabs-scroll").first();
    await expect
      .poll(() => scroll.evaluate((node) => node.scrollWidth > node.clientWidth))
      .toBe(true);

    const screenshot = await page.screenshot({
      path: testInfo.outputPath("workspace-tabs-overflow.png"),
    });
    await testInfo.attach("workspace-tabs-overflow", {
      body: screenshot,
      contentType: "image/png",
    });

    const lastTab = page.locator('[data-testid^="workspace-tab-agent_"]').last();
    const lastTabHandle = await lastTab.elementHandle();
    if (!lastTabHandle) throw new Error("Expected the final agent tab to be mounted.");
    const initiallyHidden = await scroll.evaluate((node, tab) => {
      const scrollBounds = node.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      return tabBounds.right > scrollBounds.right;
    }, lastTabHandle);
    expect(initiallyHidden).toBe(true);

    const initial = await scroll.evaluate((node) => node.scrollLeft);
    const upwardAtStart = await scroll.evaluate((node) => {
      const event = new WheelEvent("wheel", {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, scrollLeft: node.scrollLeft };
    });
    expect(upwardAtStart).toEqual({ prevented: false, scrollLeft: initial });

    const downward = await scroll.evaluate((node) => {
      const event = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, scrollLeft: node.scrollLeft };
    });
    expect(downward.prevented).toBe(true);
    expect(downward.scrollLeft).toBeGreaterThan(initial);

    const lineWheel = await scroll.evaluate((node) => {
      const previous = node.scrollLeft;
      const event = new WheelEvent("wheel", {
        deltaY: 1,
        deltaMode: 1,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, distance: node.scrollLeft - previous };
    });
    expect(lineWheel).toEqual({ prevented: true, distance: 16 });

    const modifiedWheel = await scroll.evaluate((node) => {
      const previous = node.scrollLeft;
      const event = new WheelEvent("wheel", {
        deltaY: 120,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, scrollLeft: node.scrollLeft, previous };
    });
    expect(modifiedWheel).toEqual({
      prevented: false,
      scrollLeft: modifiedWheel.previous,
      previous: modifiedWheel.previous,
    });

    const horizontalTrackpad = await scroll.evaluate((node) => {
      const previous = node.scrollLeft;
      const event = new WheelEvent("wheel", {
        deltaX: 120,
        deltaY: 24,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, scrollLeft: node.scrollLeft, previous };
    });
    expect(horizontalTrackpad).toEqual({
      prevented: false,
      scrollLeft: horizontalTrackpad.previous,
      previous: horizontalTrackpad.previous,
    });

    const atEnd = await scroll.evaluate((node, tab) => {
      const event = new WheelEvent("wheel", {
        deltaY: 1,
        deltaMode: 2,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      const reachedEnd = node.scrollLeft >= node.scrollWidth - node.clientWidth - 1;
      const scrollBounds = node.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      node.scrollLeft = node.scrollWidth;
      const boundaryEvent = new WheelEvent("wheel", {
        deltaY: 120,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(boundaryEvent);
      return {
        preventedAtBoundary: boundaryEvent.defaultPrevented,
        reachedEnd,
        lastTabVisible:
          tabBounds.left >= scrollBounds.left && tabBounds.right <= scrollBounds.right,
      };
    }, lastTabHandle);
    expect(atEnd.preventedAtBoundary).toBe(false);
    expect(atEnd.reachedEnd).toBe(true);
    expect(atEnd.lastTabVisible).toBe(true);

    const upwardFromEnd = await scroll.evaluate((node) => {
      const previous = node.scrollLeft;
      const event = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return { prevented: event.defaultPrevented, scrollLeft: node.scrollLeft, previous };
    });
    expect(upwardFromEnd.prevented).toBe(true);
    expect(upwardFromEnd.scrollLeft).toBeLessThan(upwardFromEnd.previous);

    await page.setViewportSize({ width: 2400, height: 760 });
    await expect
      .poll(() => scroll.evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);
    const afterResize = await scroll.evaluate((node) => {
      const event = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(afterResize).toBe(false);
  } finally {
    await workspace.cleanup();
  }
});
