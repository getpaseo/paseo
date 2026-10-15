import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, type Page } from "../fixtures";
import { drillIntoProvider, openModelPicker } from "./agent-profiles";

export async function startWithoutRememberedModel(page: Page) {
  await page.addInitScript(() => localStorage.removeItem("@paseo:create-agent-preferences"));
}

export async function chooseModel(page: Page, provider: string, label: string) {
  await openModelPicker(page);
  const back = page.getByRole("dialog").getByRole("button", { name: "Back", exact: true });
  if (await back.isVisible()) await back.click();
  await selectProviderModel(page, provider, label);
}

export async function reselectModel(page: Page, provider: string, label: string) {
  await chooseModel(page, provider, label);
}

async function selectProviderModel(page: Page, provider: string, label: string) {
  await drillIntoProvider(page, provider);
  await page.getByTestId("combobox-desktop-container").getByText(label, { exact: true }).click();
  await expectRememberedModel(page, label);
}

export async function expectSavedSelection(page: Page, provider: string, model: string) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("@paseo:create-agent-preferences") ?? "null"),
      ),
    )
    .toMatchObject({ providerPreferences: { [provider]: { model } } });
}

export async function expectCreatedModelAgents(
  page: Page,
  client: DaemonClient,
  provider: string,
  model: string,
  count: number,
) {
  await expect
    .poll(
      async () => {
        const result = await client.fetchAgents({ scope: "active" });
        return result.entries
          .filter(({ agent }) => agent.provider === provider)
          .map(({ agent }) => agent.model);
      },
      { timeout: 60_000 },
    )
    .toEqual(Array(count).fill(model));
  await expect(page.getByTestId(/^workspace-tab-agent_/).filter({ visible: true })).toHaveCount(1);
}

export async function expectRememberedModel(page: Page, label: string) {
  const selector = page.getByTestId("combined-model-selector").filter({ visible: true }).first();
  await expect(selector).toBeVisible();
  await expect
    .poll(async () => (await selector.getAttribute("aria-label"))?.toLowerCase())
    .toBe(`Select model (${label})`.toLowerCase());
}
