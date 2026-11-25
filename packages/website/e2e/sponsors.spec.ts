import { SPONSORS, sponsorHref } from "../src/data/sponsors";
import { expect, test } from "./fixtures";

const PAGES = ["/", "/docs/connectivity", "/changelog"];

for (const path of PAGES) {
  test(`${path} shows the sponsors and invites the next one`, async ({ page }) => {
    await page.goto(path);

    const sponsors = page.getByRole("region", { name: "Sponsors", exact: true });
    for (const sponsor of SPONSORS) {
      await expect(sponsors.getByRole("link", { name: sponsor.name })).toHaveAttribute(
        "href",
        sponsorHref(sponsor, "website"),
      );
      await expect(sponsors.getByText(sponsor.description, { exact: true })).toBeVisible();
    }
    await expect(sponsors.getByRole("link", { name: "Become a sponsor" })).toHaveAttribute(
      "href",
      "/sponsor#spot",
    );
  });
}
