import { expect, type Locator, type Page } from "@playwright/test";
import { addProjectFlow, addProjectFlowInput, chooseAddProjectMethod } from "./add-project-flow";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";

/** Points a fresh browser profile at one host, with no first-run record and no app settings. */
export async function openAppAsNewUser(
  page: Page,
  host: { serverId: string; port: number },
): Promise<void> {
  const seededHost = buildSeededHost({
    serverId: host.serverId,
    endpoint: `127.0.0.1:${host.port}`,
    nowIso: new Date().toISOString(),
  });
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, async (webSocket) => {
    await webSocket.close({ code: 1008, reason: "Blocked developer daemon during e2e." });
  });
  await page.addInitScript(
    ({ registryHost, preferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([registryHost]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    { registryHost: seededHost, preferences: buildCreateAgentPreferences() },
  );
  await page.goto("/");
}

export function setupModal(page: Page): Locator {
  return page.getByRole("dialog").filter({ hasText: "Set up Paseo" });
}

export async function expectSetupStep(page: Page, title: string): Promise<void> {
  await expect(setupModal(page).getByRole("heading", { name: title, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

export async function pickTheme(page: Page, name: string): Promise<void> {
  const tile = setupModal(page).getByRole("radio", { name, exact: true });
  await tile.click();
  await expect(tile).toBeChecked();
}

export async function continueSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Continue", exact: true }).click();
}

export async function skipSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Skip setup", exact: true }).click();
  await expect(setupModal(page)).toHaveCount(0);
}

/** Adds a folder through the regular Add project flow, opened from the setup's Projects step. */
export async function addProjectFromSetup(page: Page, projectPath: string): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Add project", exact: true }).click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await chooseAddProjectMethod(page, "directory-search");
  await addProjectFlowInput(page).fill(projectPath);
  await page.keyboard.press("Enter");
  await expect(addProjectFlow(page)).toHaveCount(0, { timeout: 30_000 });
}

export async function showSetupAgainFromSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
  await page.getByRole("button", { name: "Show setup again", exact: true }).click();
}

export async function goToSetupStep(page: Page, label: string): Promise<void> {
  await setupModal(page).getByRole("tab", { name: label, exact: true }).click();
}

export function paseoToolsSwitch(scope: Page | Locator): Locator {
  return scope.getByRole("switch", { name: "Inject Paseo tools", exact: true });
}

export async function finishSetup(page: Page): Promise<void> {
  await setupModal(page).getByRole("button", { name: "Finish", exact: true }).click();
  await expect(setupModal(page)).toHaveCount(0);
}

/** Clicks the Tailscale docs link in the Phone step and returns the page it opened. */
export async function openTailscaleDocsFromSetup(page: Page): Promise<string> {
  await page
    .context()
    .route("https://paseo.sh/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Paseo docs</title>" }),
    );
  const popup = page.waitForEvent("popup");
  await setupModal(page).getByRole("link", { name: "Read how to connect over Tailscale" }).click();
  const docs = await popup;
  await docs.waitForLoadState("domcontentloaded");
  const url = docs.url();
  await docs.close();
  return url;
}
