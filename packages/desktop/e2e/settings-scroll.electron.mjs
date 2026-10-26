import { expect } from "@playwright/test";

export async function runSettingsScrollRegression(page, resizeWindow) {
  // Device-metrics emulation also pins later webview guests. Resize the real
  // window so the following browser regression starts without an override.
  const original = await resizeWindow({ width: 1000, height: 500 });
  const sidebar = () => page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  const offset = () => sidebar().evaluate((node) => node.scrollTop);
  const observations = [];
  try {
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1000, height: 500 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sidebar().hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(offset).toBeGreaterThan(0);
    const saved = await offset();
    for (const title of ["Providers", "Terminals", "Providers", "Terminals"]) {
      const button = page
        .locator('[data-testid="settings-sidebar"]:visible')
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.locator('[data-testid="settings-detail-header-title"]:visible')).toHaveText(
        title,
      );
      await expect.poll(offset).toBe(saved);
      observations.push({ title, offset: await offset() });
    }
    const detail = page.locator('[data-testid="settings-detail-scroll-body"]:visible');
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await detail.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect.poll(offset).toBe(saved);
    observations.push({
      independentDetailOffset: await detail.evaluate((node) => node.scrollTop),
      sidebarOffset: await offset(),
    });
    await sidebar().hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(offset).toBe(0);
    await page.mouse.wheel(0, 60);
    await expect.poll(offset).toBe(60);
    for (const title of ["Sidebar", "Appearance", "Sidebar"]) {
      const button = page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.getByTestId("settings-detail-header-title")).toHaveText(title);
      await expect.poll(offset).toBe(60);
      observations.push({ title, offset: await offset() });
    }
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.poll(offset).toBe(0);
    observations.push({ reentryOffset: await offset() });
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    return observations;
  } finally {
    await resizeWindow(original);
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual(original);
  }
}
