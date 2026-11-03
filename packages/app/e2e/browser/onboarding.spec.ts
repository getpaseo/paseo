import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, metroTest as test } from "../support/fixtures";
import {
  addProjectFromSetup,
  continueSetup,
  expectSetupStep,
  finishSetup,
  goToSetupStep,
  hostGivesAgentsPaseoTools,
  openAppAsNewUser,
  openRelayPairingFromSetup,
  closeRelayPairing,
  openTailscaleDocsFromSetup,
  paseoToolsSwitch,
  pickTheme,
  projectSuggestion,
  projectSuggestionRow,
  setupModal,
  setupPrimaryButton,
  showSetupAgainFromSettings,
  skipSetup,
  startSetupHost,
} from "../support/helpers/onboarding";
import {
  chooseCustomSkills,
  openSkillSelection,
  saveSkillSelection,
} from "../support/helpers/agent-skills";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { enableRelayAndExpectOffer } from "../support/helpers/pair-device";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsHostSection } from "../support/helpers/settings";
import { createTempDirectory, createTempGitRepo } from "../support/helpers/workspace";

// Midnight's muted foreground (#9a9db0), which the step description is drawn in.
const MIDNIGHT_MUTED_FOREGROUND = "rgb(154, 157, 176)";

test("a new user is walked through setup once", async ({ page }, testInfo) => {
  const host = await startSetupHost("fresh");
  const repo = await createTempGitRepo("onboarding-folder-");

  try {
    await openAppAsNewUser(page, host);

    await test.step("setup opens on Appearance and a theme applies at once", async () => {
      await expectSetupStep(page, "Welcome to Paseo");
      await pickTheme(page, "Midnight");
      await expect(
        setupModal(page).getByText("Let's start by picking a look", { exact: true }),
      ).toHaveCSS("color", MIDNIGHT_MUTED_FOREGROUND);
      await page.screenshot({ path: testInfo.outputPath("1-appearance.png") });
    });

    await test.step("Providers shows the same provider list as Settings", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Your agents");
      await expect(setupModal(page).getByTestId("host-page-providers-card")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("2-providers.png") });
    });

    await test.step("with no agent history, Add project opens the regular flow and the folder shows as added", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Add your projects");
      await expect(
        setupModal(page).getByText("No recent projects found", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await addProjectFromSetup(page, repo.path);
      await expectSetupStep(page, "Add your projects");
      await expect(setupModal(page).getByText(repo.path, { exact: true })).toBeVisible();
      await expect(setupModal(page).getByText("Added", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("3-projects.png") });
    });

    await test.step("Orchestration starts with its switches on", async () => {
      await continueSetup(page);
      await expectSetupStep(page, "Let agents use Paseo");
      await expect(paseoToolsSwitch(setupModal(page))).toBeChecked();
      await expect(
        setupModal(page).getByRole("switch", { name: "Orchestration skills", exact: true }),
      ).toBeChecked();
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
    await host.close();
    await repo.cleanup();
  }
});

test("setup suggests the repos the user already ran agents in", async ({ page }, testInfo) => {
  const repo = await createTempGitRepo("onboarding-history-");
  const repoName = path.basename(repo.path);
  const subdirectory = path.join(repo.path, "packages", "web");
  await mkdir(subdirectory, { recursive: true });
  const worktree = `${repo.path}-fix`;
  execFileSync("git", ["worktree", "add", "-b", "fix", worktree], { cwd: repo.path });
  const scratch = await createTempDirectory("onboarding-scratch-");
  const scratchName = path.basename(scratch.path);
  const host = await startSetupHost("history", {
    claudeSessionsIn: [repo.path, subdirectory, worktree, scratch.path, scratch.path, scratch.path],
    withBrokenProvider: true,
  });

  try {
    await openAppAsNewUser(page, host);
    await expectSetupStep(page, "Welcome to Paseo");
    await goToSetupStep(page, "Projects");
    await expectSetupStep(page, "Add your projects");

    await test.step("the repo, its subfolder and its worktree become one checked row", async () => {
      await expect(projectSuggestion(page, repoName)).toBeChecked({ timeout: 60_000 });
      await expect(projectSuggestion(page, scratchName)).toBeChecked();
      await expect(setupModal(page).getByTestId("project-suggestion")).toHaveCount(2);
    });

    await test.step("a provider that cannot read its history adds nothing and shows no error", async () => {
      await expect(setupModal(page).getByTestId("project-suggestions-skeleton")).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(setupModal(page).getByText(/Broken ACP/)).toHaveCount(0);
      await expect(setupModal(page).getByTestId("project-suggestion")).toHaveCount(2);
    });

    await test.step("the footer adds what is checked; the Add project flow is separate", async () => {
      await expect(setupPrimaryButton(page, "Add 2 projects")).toBeVisible();
      await expect(setupModal(page).getByRole("button", { name: "Continue" })).toHaveCount(0);
      await expect(
        setupModal(page).getByRole("button", { name: "Add project", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("8-project-suggestions.png") });
      await projectSuggestion(page, repoName).click();
      await projectSuggestion(page, scratchName).click();
      await expect(setupPrimaryButton(page, "Continue")).toBeVisible();
      await projectSuggestion(page, repoName).click();
      await projectSuggestion(page, scratchName).click();
    });

    await test.step("a folder that cannot be added keeps the user on the step", async () => {
      await scratch.cleanup();
      await setupPrimaryButton(page, "Add 2 projects").click();
      await expect(setupPrimaryButton(page, "Add 1 project")).toBeVisible({ timeout: 30_000 });
      await expectSetupStep(page, "Add your projects");
      await expect(projectSuggestion(page, scratchName)).toBeChecked();
      await expect(projectSuggestionRow(page, scratchName)).toContainText("Directory not found");
      await expect(projectSuggestion(page, repoName)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("9-project-suggestion-failed.png") });
    });

    await test.step("with nothing checked, Continue moves on without adding", async () => {
      await projectSuggestion(page, scratchName).click();
      await setupPrimaryButton(page, "Continue").click();
      await expectSetupStep(page, "Let agents use Paseo");
      await expect(
        page.locator('[data-testid^="sidebar-project-row-"]').filter({ hasText: repoName }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator('[data-testid^="sidebar-project-row-"]').filter({ hasText: scratchName }),
      ).toHaveCount(0);
    });
  } finally {
    await host.close();
    await rm(worktree, { recursive: true, force: true });
    await repo.cleanup();
    await scratch.cleanup();
  }
});

test("an existing user only sees setup when they ask for it", async ({ page }) => {
  const host = await startSetupHost("existing");
  const workspace = await seedWorkspace({ repoPrefix: "onboarding-existing-", port: host.port });

  try {
    await openAppAsNewUser(page, host);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${host.serverId}:${workspace.workspaceId}`),
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
    await host.close();
  }
});

test("setup choices carry over to Settings and the phone step pairs over relay", async ({
  page,
}, testInfo) => {
  const host = await startSetupHost("phone", { mutableRelay: { enabled: false } });

  try {
    await openAppAsNewUser(page, host);
    await expectSetupStep(page, "Welcome to Paseo");

    await test.step("Paseo tools start on in setup and Continue turns them on", async () => {
      await goToSetupStep(page, "Orchestration");
      await expectSetupStep(page, "Let agents use Paseo");
      await expect(paseoToolsSwitch(setupModal(page))).toBeChecked();
      await continueSetup(page);
    });

    await test.step("Phone offers Tailscale docs and pairs over relay in its own modal", async () => {
      await expectSetupStep(page, "Take your agents with you");
      await page.screenshot({ path: testInfo.outputPath("5-phone.png") });
      expect(await openTailscaleDocsFromSetup(page)).toBe(
        "https://paseo.sh/docs/connectivity#tailscale",
      );
      const pairing = await openRelayPairingFromSetup(page);
      await expect(pairing.getByText("Enable relay?", { exact: true })).toBeVisible();
      await enableRelayAndExpectOffer(page);
      await page.screenshot({ path: testInfo.outputPath("6-phone-qr.png") });
      await closeRelayPairing(pairing);
    });

    await test.step("Finish closes setup and Settings shows the same Paseo tools value", async () => {
      await finishSetup(page);
      await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
      await openSettingsHostSection(page, host.serverId, "agents");
      await expect(paseoToolsSwitch(page)).toBeChecked();
      await page.screenshot({ path: testInfo.outputPath("7-settings-agents.png") });
    });
  } finally {
    await host.close();
  }
});

test("with no skills picked, skills read as off and Continue moves on", async ({ page }) => {
  const host = await startSetupHost("no-skills");

  try {
    await openAppAsNewUser(page, host);
    await expectSetupStep(page, "Welcome to Paseo");
    await goToSetupStep(page, "Orchestration");
    await expectSetupStep(page, "Let agents use Paseo");

    await openSkillSelection(page);
    await chooseCustomSkills(page, []);
    await saveSkillSelection(page);
    const skillsSwitch = setupModal(page).getByRole("switch", {
      name: "Orchestration skills",
      exact: true,
    });
    await expect(skillsSwitch).not.toBeChecked();

    await continueSetup(page);
    await expectSetupStep(page, "Take your agents with you");
  } finally {
    await host.close();
  }
});

test("in the compact layout, Finish on Orchestration applies its switches", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const host = await startSetupHost("compact");
  const gate = await installDaemonWebSocketGate(page, { port: host.port });
  // The compact sheet is the only surface on screen, and Orchestration is its last step.
  const step = (title: string) =>
    expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({
      timeout: 60_000,
    });
  const primary = (label: string) => page.getByRole("button", { name: label, exact: true });

  try {
    await openAppAsNewUser(page, host);
    await step("Welcome to Paseo");
    await primary("Continue").click();
    await step("Your agents");
    await primary("Continue").click();
    await step("Add your projects");
    await primary("Continue").click();

    // The setup host starts with Paseo tools off; the switch starts on.
    expect(await hostGivesAgentsPaseoTools(host)).toBe(false);
    await step("Let agents use Paseo");
    await expect(paseoToolsSwitch(page)).toBeChecked();
    // Skills are not installed, so leaving them off has nothing to apply.
    const skillsSwitch = page.getByRole("switch", { name: "Orchestration skills", exact: true });
    await skillsSwitch.click();
    await expect(skillsSwitch).not.toBeChecked();
    gate.holdNextClientRequest("set_daemon_config_request");
    await primary("Finish").click();

    // While the choices apply, none of them can change.
    await gate.waitForHeldClientRequest();
    await expect(paseoToolsSwitch(page)).toBeDisabled();
    await expect(skillsSwitch).toBeDisabled();
    gate.releaseHeldClientRequest();

    await expect.poll(() => hostGivesAgentsPaseoTools(host), { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole("heading", { name: "Let agents use Paseo" })).toHaveCount(0);
  } finally {
    await host.close();
  }
});
