import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

// A key sequence recorded in Settings. Both platform bindings are overridden so
// the spec does not depend on which one the runtime selects.
const COMMAND_CENTER_SEQUENCE_OVERRIDES = {
  "command-center-toggle-cmd-k-mac": "Cmd+K J",
  "command-center-toggle-ctrl-k-non-mac": "Ctrl+K J",
};

async function seedSequenceOverrideAndCountShortcutListeners(page: Page): Promise<void> {
  await page.addInitScript((overrides) => {
    localStorage.setItem("@paseo:keyboard-shortcut-overrides", JSON.stringify(overrides));
    const counter = window as unknown as { __shortcutKeydownListeners: number };
    counter.__shortcutKeydownListeners = 0;
    const addEventListener = window.addEventListener.bind(window);
    window.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      // The global shortcut handler is the capture-phase keydown listener on window.
      if (type === "keydown" && options === true) {
        counter.__shortcutKeydownListeners += 1;
      }
      addEventListener(type, listener, options);
    } as typeof window.addEventListener;
  }, COMMAND_CENTER_SEQUENCE_OVERRIDES);
}

function readShortcutListenerRegistrations(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __shortcutKeydownListeners: number }).__shortcutKeydownListeners,
  );
}

async function waitForRenderedFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.describe("Keyboard shortcut sequences", () => {
  test("a sequence completes when the window resizes between its keys", async ({ page }) => {
    await seedSequenceOverrideAndCountShortcutListeners(page);
    const workspace = await seedWorkspace({ repoPrefix: "shortcut-sequence-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await expect.poll(() => readShortcutListenerRegistrations(page)).toBeGreaterThan(0);
      const registrationsBeforeSequence = await readShortcutListenerRegistrations(page);
      const viewport = page.viewportSize();
      if (!viewport) {
        throw new Error("Expected the browser project to define a viewport");
      }

      await page.keyboard.press(`${MODIFIER}+K`);
      // Resizing re-renders the app root between the two keys of the sequence.
      await page.setViewportSize({ width: viewport.width - 40, height: viewport.height });
      await waitForRenderedFrames(page);
      const registrationsBetweenKeys = await readShortcutListenerRegistrations(page);
      await page.keyboard.press("j");

      await expect(page.getByTestId("command-center-panel")).toBeVisible();
      expect(registrationsBetweenKeys).toBe(registrationsBeforeSequence);
    } finally {
      await workspace.cleanup();
    }
  });
});
