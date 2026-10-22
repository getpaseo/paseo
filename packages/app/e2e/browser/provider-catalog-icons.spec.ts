import { ACP_PROVIDER_ICON_SVGS } from "../../src/assets/acp-provider-icons";
import { expect, test, type Page } from "../support/fixtures";
import type { TestInfo } from "@playwright/test";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  findAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

async function openProviderCatalog(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");
  await openAddProviderArea(page);
}

async function expectProviderArtwork(
  page: Page,
  testInfo: TestInfo,
  id: "devin" | "hermes" | "kiro",
  name: string,
) {
  await findAcpCatalogProvider(page, name);
  // Catalog tiles have no semantic role; scope artwork to the named provider's tile.
  const icon = page.getByTestId(`provider-catalog-tile-${id}`).locator("svg").first();
  await expect(icon).toBeVisible();
  // Provider artwork is 24px; the generic PackagePlus fallback is 20px.
  await expect.soft(icon).toHaveAttribute("width", "24");
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
