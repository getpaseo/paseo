import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  fillProviderAccountForm,
  openProviderAccountForm,
  openSettingsHost,
  openSettingsHostSection,
  submitProviderAccountForm,
} from "../support/helpers/settings";

const BASE_PROVIDER_ID = "claude";
const ACCOUNT = {
  id: "claude-work",
  label: "Claude (Work)",
} as const;

interface ProviderAccountDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  patchDaemonConfig(config: { removeProviders?: string[] }): Promise<unknown>;
  getDaemonConfig(): Promise<{
    config: {
      providers?: Record<
        string,
        { extends?: string; label?: string; description?: string; env?: Record<string, string> }
      >;
    };
  }>;
}

test.describe("provider accounts", () => {
  test("creates a second account for a builtin provider", async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<ProviderAccountDaemonClient>({
      clientIdPrefix: "provider-account-e2e",
    });

    try {
      await client.patchDaemonConfig({ removeProviders: [ACCOUNT.id] }).catch(() => undefined);

      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");

      await openProviderAccountForm(page, BASE_PROVIDER_ID);

      // The id is derived from the label until it is edited by hand.
      await page.getByTestId("provider-account-label-input").fill(ACCOUNT.label);
      await expect(page.getByTestId("provider-account-id-input")).toHaveValue(ACCOUNT.id);

      // A reserved id is rejected inline.
      await page.getByTestId("provider-account-id-input").fill(BASE_PROVIDER_ID);
      await expect(page.getByTestId("provider-account-id-error")).toBeVisible();
      await page.getByTestId("provider-account-id-input").fill(ACCOUNT.id);
      await expect(page.getByTestId("provider-account-id-error")).toHaveCount(0);

      await fillProviderAccountForm(page, {
        label: ACCOUNT.label,
        providerId: ACCOUNT.id,
        description: "Work account",
        env: [{ key: "ANTHROPIC_API_KEY", value: "sk-e2e-test" }],
      });
      await submitProviderAccountForm(page);

      await expect(page.getByTestId("provider-account-sheet")).toHaveCount(0);
      await expectProviderInstalledInSettings(page, ACCOUNT.label);

      await expect
        .poll(async () => {
          const { config } = await client.getDaemonConfig();
          const entry = config.providers?.[ACCOUNT.id];
          if (!entry) return null;
          return {
            extends: entry.extends,
            label: entry.label,
            description: entry.description,
            env: entry.env,
          };
        })
        .toEqual({
          extends: BASE_PROVIDER_ID,
          label: ACCOUNT.label,
          description: "Work account",
          env: { ANTHROPIC_API_KEY: "sk-e2e-test" },
        });
    } finally {
      await client.patchDaemonConfig({ removeProviders: [ACCOUNT.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});
