import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { getServerId } from "./server-id";
import { openSettingsHostSection } from "./settings";

type PaseoAgentDaemonClient = Pick<
  InternalDaemonClient,
  | "close"
  | "connect"
  | "removePaseoAgentProvider"
  | "setPaseoAgentProvider"
  | "storePaseoAgentOAuthCredential"
>;

interface ApiKeyProviderInput {
  catalogId: string;
  apiKey: string;
}

interface OAuthProviderInput {
  catalogId: string;
}

interface ExpectedProvider {
  name: string;
  providerLabel: string;
  auth: "Connected" | "Needs attention";
  modelCount: number;
}

async function connectPaseoAgentClient(): Promise<PaseoAgentDaemonClient> {
  return connectDaemonClient<PaseoAgentDaemonClient>({ clientIdPrefix: "paseo-agent-e2e" });
}

export async function openPaseoAgentSettings(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "providers");
  await page.getByRole("button", { name: "Paseo Agent provider details", exact: true }).click();
  const sheet = page.getByTestId("paseo-agent-settings-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Paseo Agent", { exact: true })).toBeVisible();
}

export async function addApiKeyProvider(page: Page, provider: ApiKeyProviderInput): Promise<void> {
  await page.getByRole("button", { name: "Add model provider", exact: true }).click();
  await expect(page.getByTestId("paseo-agent-provider-picker")).toBeVisible();
  await page.getByTestId(`paseo-agent-catalog-select-${provider.catalogId}`).click();
  await expect(page.getByTestId("paseo-agent-provider-form")).toBeVisible();

  await expect(page.getByLabel("Provider name")).toHaveCount(0);
  await expect(page.getByLabel("Models")).toHaveCount(0);
  await page.getByLabel("API key").fill(provider.apiKey);
  await page.getByRole("button", { name: "Save provider", exact: true }).click();

  await expect(page.getByTestId("paseo-agent-provider-form")).toHaveCount(0);
  await expect(page.getByText(provider.apiKey, { exact: true })).toHaveCount(0);
}

export async function startOAuthProviderSignIn(
  page: Page,
  provider: OAuthProviderInput,
): Promise<void> {
  await page.getByRole("button", { name: "Add model provider", exact: true }).click();
  await expect(page.getByTestId("paseo-agent-provider-picker")).toBeVisible();
  await page.getByTestId(`paseo-agent-catalog-select-${provider.catalogId}`).click();

  await expect(page.getByTestId("paseo-agent-provider-form")).toHaveCount(0);
  await expect(page.getByTestId("paseo-agent-oauth-sign-in")).toBeVisible();
  await expect(page.getByLabel("Provider name")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in with browser", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use a code instead", exact: true }).click();
  await expect(page.getByTestId("paseo-agent-oauth-user-code")).toBeVisible();
  await expect(page.getByTestId("paseo-agent-oauth-verification-link")).toBeVisible();
}

export async function expectModelProviderListed(
  page: Page,
  expected: ExpectedProvider,
): Promise<void> {
  const modelLabel = expected.modelCount === 1 ? "1 model" : `${expected.modelCount} models`;
  await expect(
    page.getByRole("listitem", {
      name: new RegExp(
        `${expected.name}.*${expected.providerLabel}.*${modelLabel}.*${expected.auth}`,
      ),
    }),
  ).toBeVisible();
}

export async function seedChatGptProvider(providerName: string): Promise<void> {
  const client = await connectPaseoAgentClient();
  try {
    await client.setPaseoAgentProvider({
      name: providerName,
      providerType: "chatgpt",
      options: {
        models: [{ id: "gpt-5.4-mini", reasoning: true }],
      },
    });
    await client.storePaseoAgentOAuthCredential({
      name: providerName,
      credential: {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 4_102_444_800,
        futureField: { passthrough: true },
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function cleanupPaseoAgentProviders(providerNames: Iterable<string>): Promise<void> {
  const client = await connectPaseoAgentClient();
  try {
    for (const name of providerNames) {
      await client.removePaseoAgentProvider(name);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}
