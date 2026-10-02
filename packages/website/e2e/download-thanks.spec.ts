import { expect, test, type Page } from "playwright/test";

const APPLE_SILICON_DMG = /\/getpaseo\/paseo\/releases\/download\/v[^/]+\/Paseo-[^/]+-arm64\.dmg$/;

async function openDownloadPage(page: Page) {
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
}

async function clickAppleSilicon(page: Page) {
  await page.getByRole("link", { name: "Apple Silicon", exact: true }).click();
}

test("a download button opens the thanks page and requests the file", async ({ page }) => {
  await openDownloadPage(page);

  const fileRequest = page.waitForRequest(APPLE_SILICON_DMG);
  await clickAppleSilicon(page);

  await fileRequest;
  await expect(page).toHaveURL(/\/download\/thanks\?file=/);
  await expect(page.getByRole("heading", { name: "Thanks for downloading Paseo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    APPLE_SILICON_DMG,
  );
});

test("the thanks page starts a browser download", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit reports no download event for a stubbed response");
  await openDownloadPage(page);

  const download = page.waitForEvent("download");
  await clickAppleSilicon(page);

  expect((await download).url()).toMatch(APPLE_SILICON_DMG);
});
