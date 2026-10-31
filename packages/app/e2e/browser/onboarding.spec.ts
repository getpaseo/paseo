import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, metroTest as test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  addProjectFromSetup,
  continueSetup,
  expectSetupStep,
  finishSetup,
  goToSetupStep,
  openAppAsNewUser,
  openTailscaleDocsFromSetup,
  paseoToolsSwitch,
  pickTheme,
  setupModal,
  showSetupAgainFromSettings,
  skipSetup,
} from "../support/helpers/onboarding";
import { enableRelayAndExpectOffer } from "../support/helpers/pair-device";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsHostSection } from "../support/helpers/settings";
import { createTempGitRepo } from "../support/helpers/workspace";

// Midnight's muted foreground (#9a9db0), which the step description is drawn in.
const MIDNIGHT_MUTED_FOREGROUND = "rgb(154, 157, 176)";

function isolatedServerId(label: string): string {
  return `srv_onboarding_${label}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

test("a new user is walked through setup once", async ({ page }, testInfo) => {
  const serverId = isolatedServerId("fresh");
  const daemon = await startIsolatedHostDaemon(serverId);
  const repo = await createTempGitRepo("onboarding-folder-");

  try {
    await openAppAsNewUser(page, { serverId, port: daemon.port });

    await test.step("setup opens on Appearance and a theme applies at once", async () => {
      await expectSetupStep(page, "Welcome to Paseo");
      await pickTheme(page, "Midnight");
      await expect(
        setupModal(page).getByText(/^Run Claude Code, Codex and other agents/),
      ).toHaveCSS("color", MIDNIGHT_MUTED_FOREGROUND);
      await page.screenshot({ path: testInfo.outputPath("1-appearance.png") });
    });

    await test.step("Providers shows the same provider list as Settings", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Your agents");
      await expect(setupModal(page).getByTestId("host-page-providers-card")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("2-providers.png") });
    });

    await test.step("Add project opens the regular flow and the folder shows as added", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Add your projects");
      await addProjectFromSetup(page, repo.path);
      await expectSetupStep(page, "Add your projects");
      await expect(setupModal(page).getByText(repo.path, { exact: true })).toBeVisible();
      await expect(setupModal(page).getByText("Added", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("3-projects.png") });
    });

    await test.step("Orchestration shows the Paseo tools switch", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Let agents use Paseo");
      await expect(
        setupModal(page).getByRole("switch", { name: "Inject Paseo tools", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("4-orchestration.png") });
    });

    await test.step("Skip setup closes it for good", async () => {
      await skipSetup(page);
      await page.reload();
      await expect(
        page.locator('[data-testid^="sidebar-project-row-"]').filter({
          hasText: path.basename(repo.path),
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(setupModal(page)).toHaveCount(0);
    });
  } finally {
    await daemon.close();
    await repo.cleanup();
  }
});

test("an existing user only sees setup when they ask for it", async ({ page }) => {
  const serverId = isolatedServerId("existing");
  const daemon = await startIsolatedHostDaemon(serverId);
  const workspace = await seedWorkspace({ repoPrefix: "onboarding-existing-", port: daemon.port });

  try {
    await openAppAsNewUser(page, { serverId, port: daemon.port });
    await expect(
      page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`),
    ).toBeVisible({ timeout: 60_000 });
    await expect(setupModal(page)).toHaveCount(0);

    await showSetupAgainFromSettings(page);
    await expectSetupStep(page, "Welcome to Paseo");
    await expect(setupModal(page).getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    await workspace.cleanup();
    await daemon.close();
  }
});

test("setup choices carry over to Settings and the phone step pairs over relay", async ({
  page,
}, testInfo) => {
  const serverId = isolatedServerId("phone");
  const daemon = await startIsolatedHostDaemon(serverId, { mutableRelay: { enabled: false } });

  try {
    await openAppAsNewUser(page, { serverId, port: daemon.port });
    await expectSetupStep(page, "Welcome to Paseo");

    await test.step("Paseo tools turned on in setup", async () => {
      await goToSetupStep(page, "Orchestration");
      await expectSetupStep(page, "Let agents use Paseo");
      await expect(paseoToolsSwitch(setupModal(page))).not.toBeChecked();
      await paseoToolsSwitch(setupModal(page)).click();
      await expect(paseoToolsSwitch(setupModal(page))).toBeChecked();
    });

    await test.step("Phone asks for relay consent, then shows the pairing QR", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Take your agents with you");
      await expect(setupModal(page).getByText("Enable relay?", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("5-phone-consent.png") });
      expect(await openTailscaleDocsFromSetup(page)).toBe(
        "https://paseo.sh/docs/connectivity#tailscale",
      );
      await enableRelayAndExpectOffer(page);
      await page.screenshot({ path: testInfo.outputPath("6-phone-qr.png") });
    });

    await test.step("Finish closes setup and Settings shows the same Paseo tools value", async () => {
      await finishSetup(page);
      await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
      await openSettingsHostSection(page, serverId, "agents");
      await expect(paseoToolsSwitch(page)).toBeChecked();
      await page.screenshot({ path: testInfo.outputPath("7-settings-agents.png") });
    });
  } finally {
    await daemon.close();
  }
});
