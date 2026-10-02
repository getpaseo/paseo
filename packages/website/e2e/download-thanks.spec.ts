import { expect, test } from "playwright/test";

const RELEASE_ASSETS = "https://github.com/getpaseo/paseo/releases/download/**";

test("a download button opens the thanks page and starts the download", async ({ page }) => {
  await page.route(RELEASE_ASSETS, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-disposition": "attachment; filename=Paseo.dmg" },
      body: "",
    }),
  );
  await page.goto("/download");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Apple Silicon", exact: true }).click();

  await expect(page).toHaveURL(/\/download\/thanks\?asset=macAppleSilicon$/);
  expect((await download).url()).toMatch(/-arm64\.dmg$/);
  await expect(page.getByRole("heading", { name: "Thanks for downloading Paseo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    /-arm64\.dmg$/,
  );
});
