import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";

// The app draws its own minimise/maximise/close on Windows and Linux, so these buttons are
// ordinary DOM and can be driven in the renderer suite. macOS keeps OS traffic lights, which is
// why the runtime stub reports win32 here.
test.describe("App-drawn window controls", () => {
  test("renders one set, labelled, and each button calls its own bridge method", async ({
    page,
  }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "win32" });
    await gotoAppShell(page);

    const minimize = page.getByTestId("window-control-minimize");
    const middle = page.getByTestId("window-control-maximize");
    const close = page.getByTestId("window-control-close");

    await expect(minimize).toBeVisible();
    await expect(middle).toBeVisible();
    await expect(close).toBeVisible();

    // Two surfaces both mounting a set is the bug corner ownership exists to prevent.
    await expect(page.getByTestId("window-control-close")).toHaveCount(1);

    await expect(minimize).toHaveAttribute("aria-label", "Minimize");
    await expect(close).toHaveAttribute("aria-label", "Close");

    await minimize.click();
    await close.click();
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["minimize", "close"]);
  });

  test("the middle control follows the window state it is reporting", async ({ page }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "win32" });
    await gotoAppShell(page);

    const middle = page.getByTestId("window-control-maximize");
    await expect(middle).toHaveAttribute("aria-label", "Maximize");

    // The bridge flips its own state and fires the resize event the app subscribes to, so this
    // also covers the subscription rather than just the label.
    await middle.click();
    await expect(middle).toHaveAttribute("aria-label", "Restore");
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["toggleMaximize"]);

    await middle.click();
    await expect(middle).toHaveAttribute("aria-label", "Maximize");
  });

  test("fullscreen reads as Restore and leaves fullscreen rather than maximising", async ({
    page,
  }) => {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      platform: "win32",
      windowState: { fullscreen: true },
    });
    await gotoAppShell(page);

    const middle = page.getByTestId("window-control-maximize");
    // Windows reports isMaximized() === false while fullscreen; keying off that alone used to
    // label an already-full window "Maximize".
    await expect(middle).toHaveAttribute("aria-label", "Restore");

    await middle.click();
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["setFullscreen:false"]);
    await expect(middle).toHaveAttribute("aria-label", "Maximize");
  });

  test("macOS renders no app-drawn controls, because the OS draws traffic lights", async ({
    page,
  }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "darwin" });
    await gotoAppShell(page);

    await expect(page.getByTestId("window-control-close")).toHaveCount(0);
    await expect(page.getByTestId("window-control-minimize")).toHaveCount(0);
  });
});
