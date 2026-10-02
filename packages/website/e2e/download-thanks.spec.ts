import { expect, test } from "playwright/test";

const APPLE_SILICON_DMG = /\/getpaseo\/paseo\/releases\/download\/v[^/]+\/Paseo-[^/]+-arm64\.dmg$/;

test("a download button opens the thanks page and starts the download", async ({ page }) => {
  // Serve a stand-in file so the test never downloads a real release.
  await page.route(APPLE_SILICON_DMG, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=Paseo.dmg",
      },
      body: "dmg",
    }),
  );
  await page.goto("/download");

  // WebKit does not report a download event for a stubbed response, so the
  // request for the file is what proves the download started.
  const fileRequest = page.waitForRequest(APPLE_SILICON_DMG);
  await page.getByRole("link", { name: "Apple Silicon", exact: true }).click();

  await fileRequest;
  await expect(page).toHaveURL(/\/download\/thanks\?file=/);
  await expect(page.getByRole("heading", { name: "Thanks for downloading Paseo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    APPLE_SILICON_DMG,
  );
});
