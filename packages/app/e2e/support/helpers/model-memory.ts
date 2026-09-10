import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, type Page } from "../fixtures";
import { drillIntoProvider, openModelPicker } from "./agent-profiles";

export async function startWithoutRememberedModel(page: Page) {
  await page.addInitScript(() => localStorage.removeItem("@paseo:create-agent-preferences"));
}

export async function chooseModel(page: Page, provider: string, label: string) {
  await openModelPicker(page);
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }),
  ).toHaveCount(0);
  await selectProviderModel(page, provider, label);
}

export async function reselectModel(page: Page, provider: string, label: string) {
  await expectRememberedModel(page, label);
  await openModelPicker(page);
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await selectProviderModel(page, provider, label);
}

async function selectProviderModel(page: Page, provider: string, label: string) {
  await drillIntoProvider(page, provider);
  await page.getByTestId("combobox-desktop-container").getByText(label, { exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: `Select model (${label})`, exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
}

export async function expectSavedSelection(page: Page, provider: string, model: string) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("@paseo:create-agent-preferences") ?? "null"),
      ),
    )
    .toMatchObject({ provider, providerPreferences: { [provider]: { model } } });
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
  await expect(
    page
      .getByRole("button", { name: `Select model (${label})`, exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
}
