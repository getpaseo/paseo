import { ACP_PROVIDER_ICON_SVGS } from "../../src/assets/acp-provider-icons";
import { expect, test, type Page } from "../support/fixtures";
import type { Locator, TestInfo } from "@playwright/test";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  findAcpCatalogProvider,
  openAddProvider,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

async function openProviderCatalog(page: Page, viewport?: { width: number; height: number }) {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");
  if (viewport) await page.setViewportSize(viewport);
  await openAddProvider(page);
}

async function expectProviderArtwork(
  page: Page,
  testInfo: TestInfo,
  id: "devin" | "hermes" | "kiro",
  name: string,
) {
  await findAcpCatalogProvider(page, name);
  // Catalog rows have no semantic role of their own; scope artwork to the named provider's row.
  const icon = page.getByTestId(`provider-catalog-row-${id}`).locator("svg").first();
  await expect(icon).toBeVisible();
  // Artwork draws at the provider list's icon size, so the catalog and the list share a rail.
  await expect.soft(icon).toHaveAttribute("width", "16");
  const expectedPaths = await page.evaluate((xml) => {
    const document = new DOMParser().parseFromString(xml, "image/svg+xml");
    return Array.from(document.querySelectorAll("path"), (path) => path.getAttribute("d")!);
  }, ACP_PROVIDER_ICON_SVGS[id]);
  await expect(icon.locator("path")).toHaveCount(expectedPaths.length);
  for (const [index, path] of expectedPaths.entries()) {
    await expect(icon.locator("path").nth(index)).toHaveAttribute("d", path);
  }
  await page.screenshot({ path: testInfo.outputPath(`${id}-catalog.png`) });
}

test("#7087: the provider catalog shows Devin, Hermes, and Kiro artwork", async ({
  page,
}, testInfo) => {
  await openProviderCatalog(page);
  await expectProviderArtwork(page, testInfo, "devin", "Devin CLI");
  await expectProviderArtwork(page, testInfo, "hermes", "Hermes");
  await expectProviderArtwork(page, testInfo, "kiro", "Kiro CLI");
});

/** The space between a row's icon and its label, as drawn. */
async function gapAfterIcon(row: Locator, label: string): Promise<number> {
  const icon = await row.locator("svg").first().boundingBox();
  const text = await row.getByText(label, { exact: true }).boundingBox();
  if (!icon || !text) throw new Error(`${label} has no icon or label on screen`);
  return text.x - (icon.x + icon.width);
}

test("catalog rows keep the provider list's icon rail on a phone", async ({ page }) => {
  await openProviderCatalog(page, { width: 390, height: 844 });
  await findAcpCatalogProvider(page, "Kiro CLI");

  const listGap = await gapAfterIcon(page.getByTestId("provider-row-claude"), "Claude");
  const catalogGap = await gapAfterIcon(page.getByTestId("provider-catalog-row-kiro"), "Kiro CLI");
  expect(catalogGap).toBe(listGap);
});
