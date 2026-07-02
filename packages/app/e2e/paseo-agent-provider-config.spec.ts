import { expect } from "@playwright/test";
import { test } from "./fixtures";
import {
  addApiKeyProvider,
  cleanupPaseoAgentProviders,
  expectModelProviderListed,
  openPaseoAgentSettings,
  seedChatGptProvider,
  startOAuthProviderSignIn,
} from "./helpers/paseo-agent";

const CHATGPT_PROVIDER = "phase-e-chatgpt-ui";
const CLOSE_PROVIDER = "phase-e-close-ui";
const DEFAULT_OPENROUTER_PROVIDER = "OpenRouter";
const DEFAULT_CHATGPT_PROVIDER = "ChatGPT";
const RENAME_PROVIDER = "phase-e-rename-ui";

test.describe("Paseo Agent provider configuration", () => {
  const providerNamesToCleanup = new Set<string>();

  test.afterEach(async () => {
    await cleanupPaseoAgentProviders(providerNamesToCleanup);
    providerNamesToCleanup.clear();
  });

  test("adds an OpenRouter model provider from Settings", async ({ page }) => {
    providerNamesToCleanup.add(DEFAULT_OPENROUTER_PROVIDER);

    await openPaseoAgentSettings(page);
    await addApiKeyProvider(page, {
      catalogId: "openrouter",
      apiKey: "sk-or-phase-e-write-only",
    });

    await expectModelProviderListed(page, {
      name: DEFAULT_OPENROUTER_PROVIDER,
      providerLabel: "OpenRouter",
      modelCount: 0,
      auth: "Connected",
    });
  });

  test("adds an API-key provider without prompting for a provider name", async ({ page }) => {
    providerNamesToCleanup.add(DEFAULT_OPENROUTER_PROVIDER);

    await openPaseoAgentSettings(page);
    await page.getByRole("button", { name: "Add model provider", exact: true }).click();
    await page.getByTestId("paseo-agent-catalog-select-openrouter").click();

    await expect(page.getByTestId("paseo-agent-provider-form")).toBeVisible();
    await expect(page.getByLabel("Provider name")).toHaveCount(0);
    await expect(page.getByLabel("Models")).toHaveCount(0);
    await page.getByLabel("API key").fill("sk-or-default-name");
    await page.getByRole("button", { name: "Save provider", exact: true }).click();

    await expectModelProviderListed(page, {
      name: DEFAULT_OPENROUTER_PROVIDER,
      providerLabel: "OpenRouter",
      modelCount: 0,
      auth: "Connected",
    });
  });

  test("starts a ChatGPT sign-in from Settings", async ({ page }) => {
    providerNamesToCleanup.add(DEFAULT_CHATGPT_PROVIDER);

    await openPaseoAgentSettings(page);
    await startOAuthProviderSignIn(page, {
      catalogId: "chatgpt",
    });
  });

  test("starts OAuth sign-in without prompting for a provider name", async ({ page }) => {
    providerNamesToCleanup.add(DEFAULT_CHATGPT_PROVIDER);

    await openPaseoAgentSettings(page);
    await page.getByRole("button", { name: "Add model provider", exact: true }).click();
    await page.getByTestId("paseo-agent-catalog-select-chatgpt").click();

    await expect(page.getByTestId("paseo-agent-provider-form")).toHaveCount(0);
    await expect(page.getByLabel("Provider name")).toHaveCount(0);
  });

  test("shows user-facing provider picker rows", async ({ page }) => {
    await openPaseoAgentSettings(page);
    await page.getByRole("button", { name: "Add model provider", exact: true }).click();

    const picker = page.getByTestId("paseo-agent-provider-picker");
    await expect(
      page
        .getByTestId("paseo-agent-catalog-entry-openrouter")
        .getByText("API key", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("paseo-agent-catalog-icon-openrouter")).toBeVisible();
    await expect(
      page.getByTestId("paseo-agent-catalog-entry-chatgpt").getByText("Sign in", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("paseo-agent-catalog-icon-chatgpt")).toBeVisible();
    await expect(picker.getByText("openai-codex-responses")).toHaveCount(0);
    await expect(picker.getByText(/\b\d+ models?\b/)).toHaveCount(0);
  });

  test("shows a stored ChatGPT login as a read-only model provider row", async ({ page }) => {
    providerNamesToCleanup.add(CHATGPT_PROVIDER);

    await seedChatGptProvider(CHATGPT_PROVIDER);
    await openPaseoAgentSettings(page);

    await expectModelProviderListed(page, {
      name: CHATGPT_PROVIDER,
      providerLabel: "ChatGPT",
      modelCount: 1,
      auth: "Connected",
    });
  });

  test("renames a configured provider row without changing its stored credential key", async ({
    page,
  }) => {
    providerNamesToCleanup.add(RENAME_PROVIDER);

    await seedChatGptProvider(RENAME_PROVIDER);
    await openPaseoAgentSettings(page);
    await page.getByTestId(`paseo-agent-provider-rename-${RENAME_PROVIDER}`).click();
    await expect(page.getByTestId("paseo-agent-provider-rename-form")).toBeVisible();
    await page.getByLabel("Provider name").fill("Work account");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expectModelProviderListed(page, {
      name: "Work account",
      providerLabel: "ChatGPT",
      modelCount: 1,
      auth: "Connected",
    });
  });

  test("closes the Paseo Agent settings sheet after providers load", async ({ page }) => {
    providerNamesToCleanup.add(CLOSE_PROVIDER);

    await seedChatGptProvider(CLOSE_PROVIDER);
    await openPaseoAgentSettings(page);
    await expectModelProviderListed(page, {
      name: CLOSE_PROVIDER,
      providerLabel: "ChatGPT",
      modelCount: 1,
      auth: "Connected",
    });

    await page.getByLabel("Close", { exact: true }).click();

    await expect(page.getByTestId("paseo-agent-settings-sheet")).toHaveCount(0);
  });
});
