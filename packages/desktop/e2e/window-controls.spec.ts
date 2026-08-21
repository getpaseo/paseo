import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";

// The app draws its own minimise/maximise/close on Windows and Linux, so these buttons are
// ordinary DOM and can be driven in the renderer suite. macOS keeps OS traffic lights, which is
// why the runtime stub reports win32 here.
//
// Everything is located by role and accessible name rather than test ID: these are the semantics
// a screen reader and the OS see, so a regression in them should fail a test rather than pass
// quietly behind a stable test ID.
const control = (page: Parameters<typeof gotoAppShell>[0], name: string) =>
  page.getByRole("button", { name, exact: true });

test.describe("App-drawn window controls", () => {
  test("renders one set, and each button calls its own bridge method", async ({ page }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "win32" });
    await gotoAppShell(page);

    const minimize = control(page, "Minimize");
    const maximize = control(page, "Maximize");
    const close = control(page, "Close");

    await expect(minimize).toBeVisible();
    await expect(maximize).toBeVisible();
    await expect(close).toBeVisible();

    // Two surfaces both mounting a set is the bug corner ownership exists to prevent.
    await expect(minimize).toHaveCount(1);
    await expect(close).toHaveCount(1);

    await minimize.click();
    await close.click();
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["minimize", "close"]);
  });

  test("the middle control follows the window state it is reporting", async ({ page }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "win32" });
    await gotoAppShell(page);

    await expect(control(page, "Maximize")).toBeVisible();

    // The bridge flips its own state and fires the resize event the app subscribes to, so this
    // also covers the subscription rather than just the accessible name.
    await control(page, "Maximize").click();
    await expect(control(page, "Restore")).toBeVisible();
    await expect(control(page, "Maximize")).toHaveCount(0);
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["toggleMaximize"]);

    await control(page, "Restore").click();
    await expect(control(page, "Maximize")).toBeVisible();
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

    // Windows reports isMaximized() === false while fullscreen; keying off that alone used to
    // offer "Maximize" on a window that already filled the screen.
    await expect(control(page, "Restore")).toBeVisible();

    await control(page, "Restore").click();
    expect(await page.evaluate(() => window.__windowControlCalls)).toEqual(["setFullscreen:false"]);
    await expect(control(page, "Maximize")).toBeVisible();
  });

  test("macOS renders no app-drawn controls, because the OS draws traffic lights", async ({
    page,
  }) => {
    await installDesktopRuntime(page, { serverId: getServerId(), platform: "darwin" });
    await gotoAppShell(page);

    await expect(control(page, "Minimize")).toHaveCount(0);
    await expect(control(page, "Maximize")).toHaveCount(0);
    await expect(control(page, "Close")).toHaveCount(0);
  });
});
