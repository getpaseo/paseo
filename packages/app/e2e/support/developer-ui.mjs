/** @param {import('@playwright/test').Page} page */
export async function installDeveloperToastDismissal(page) {
  // Developer chrome must not cover app actions or move the test's pointer/focus.
  // Console errors remain in the runner's logs.
  const dismiss = page.locator("#error-toast").getByRole("button", { name: "", exact: true });
  await page.addLocatorHandler(dismiss, () => dismiss.dispatchEvent("click"), {
    // A new logged error can replace the toast before the old one disappears.
    noWaitAfter: true,
  });
}
