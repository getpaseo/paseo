import { expect, test } from "playwright/test";

const PAGES = ["/", "/docs/connectivity", "/changelog"];

for (const path of PAGES) {
  test(`${path} shows the sponsors and invites the next one`, async ({ page }) => {
    await page.goto(path);

    const sponsors = page.getByRole("region", { name: "Sponsored by" });
    await expect(sponsors.getByRole("link", { name: "Hoplite" })).toHaveAttribute(
      "href",
      "https://hoplite.sh/?utm_source=paseo&utm_medium=website&utm_campaign=sponsor",
    );
    await expect(sponsors.getByRole("link", { name: "Become a sponsor" })).toHaveAttribute(
      "href",
      "/sponsor#spot",
    );
  });
}
