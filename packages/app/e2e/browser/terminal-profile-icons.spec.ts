import { ACP_PROVIDER_ICON_SVGS } from "../../src/assets/acp-provider-icons";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { openLaunchMenu } from "../support/helpers/new-workspace-launch";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Harmless commands: this journey opens the profile menu without launching them.
test.use({
  e2eDaemonConfig: {
    version: 1,
    daemon: {
      terminalProfiles: [
        { id: "antigravity", name: "Antigravity artwork", command: "/bin/sh", icon: "agy" },
        { id: "cursor", name: "Cursor artwork", command: "/bin/sh", icon: "cursor" },
        { id: "unknown", name: "Unknown artwork", command: "/bin/sh", icon: "unknown-icon" },
      ],
    },
  },
});

function profileIcon(page: Page, name: string) {
  return page.getByRole("menuitem", { name: new RegExp(`^${name} artwork`) }).locator("svg");
}

async function expectBundledArtwork(page: Page, name: string, artwork: string) {
  const icon = profileIcon(page, name);
  await expect(icon).toBeVisible();
  const expectedPaths = await page.evaluate((xml) => {
    const document = new DOMParser().parseFromString(xml, "image/svg+xml");
    return Array.from(document.querySelectorAll("path"), (path) => path.getAttribute("d")!);
  }, artwork);
  await expect(icon.locator("path")).toHaveCount(expectedPaths.length);
  for (const [index, path] of expectedPaths.entries()) {
    await expect(icon.locator("path").nth(index)).toHaveAttribute("d", path);
  }
  await expect(icon).toHaveAttribute("width", "14");
  await expect(icon).toHaveAttribute("height", "14");
  const terminalColor = await page
    .getByRole("menuitem", { name: "Terminal", exact: true })
    .locator("svg")
    .evaluate((element) => getComputedStyle(element).stroke);
  await expect(icon.locator("path").first()).toHaveCSS("fill", terminalColor);
}

async function expectUnknownArtworkFallback(page: Page) {
  const icon = profileIcon(page, "Unknown");
  await expect(icon).toBeVisible();
  await expect(icon.locator('path[d="M12 8V4H8"]')).toHaveCount(1);
}

test("terminal profiles show bundled artwork while unknown icons keep the Bot fallback", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "terminal-icons-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await openLaunchMenu(page);
    await expectBundledArtwork(page, "Antigravity", ACP_PROVIDER_ICON_SVGS.agy);
    await expectBundledArtwork(page, "Cursor", ACP_PROVIDER_ICON_SVGS.cursor);
    await expectUnknownArtworkFallback(page);
  } finally {
    await workspace.cleanup();
  }
});
