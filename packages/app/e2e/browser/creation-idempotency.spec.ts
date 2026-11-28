import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createCreationScenario } from "../support/helpers/creation";
import { gotoAppShell } from "../support/helpers/app";
import { fillComposerDraft } from "../support/helpers/composer";
import {
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import {
  seedTerminalProfiles,
  selectLaunchOption,
  submitTerminalLaunch,
} from "../support/helpers/new-workspace-launch";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { expect } from "../support/fixtures";
import { test } from "../support/creation-fixtures";

for (const isolation of ["local", "worktree"] as const) {
  test(`repeated Create clicks before a render create only one ${isolation} workspace`, async ({
    creation,
  }) => {
    await creation.openWorkspaceForm(isolation);
    await creation.submitRepeatedly("Create");
    await creation.expectOneCreatedWorkspace();
  });
}

test("repeated Send clicks before a render create only one agent", async ({ creation }) => {
  await creation.openAgentDraft();
  await creation.submitRepeatedly("Send message", "Start exactly one agent for this prompt.");
  await creation.expectPromptVisible();
  await creation.expectAgentCount(1);
});

test("retrying the app's agent creation returns the same agent for every attempt", async ({
  creation,
  agentRetries,
}) => {
  await creation.openAgentDraft();
  await creation.submitPrompt("Start exactly one agent for this prompt.");
  expect(new Set(await agentRetries.completedAgentIds()).size).toBe(1);
  await creation.expectAgentCount(1);
});

test("the first prompt still names an agent created with a receipt", async ({ creation }) => {
  await creation.openAgentDraft();
  await creation.submitPrompt("Name this new agent from its first prompt.");
  await creation.expectPromptVisible();
  await creation.expectAgentTitle("Name this new agent from its first prompt.");
});

test("reconnecting after a lost creation response recovers the agent and initial message", async ({
  creation,
  promptRetry,
}) => {
  await creation.openAgentDraft();
  promptRetry.holdAcknowledgement();
  await creation.submitPrompt("Deliver this initial prompt once.");
  await promptRetry.waitForDeliveredPrompt();
  await promptRetry.disconnectAndReconnect();
  await promptRetry.expectSameAgentAndMessage();
  await creation.expectAgentCount(1);
});

test("a remounted draft reconciles its original creation after reconnect", async ({
  creation,
  promptRetry,
}) => {
  await creation.openAgentDraft();
  promptRetry.holdAcknowledgement();
  await creation.submitPrompt("Deliver this initial prompt once.");
  await promptRetry.waitForDeliveredPrompt();
  await creation.evictAndReturnToDraft();
  await creation.expectPromptVisible("Deliver this initial prompt once.");
  await promptRetry.disconnectAndReconnect();
  await promptRetry.expectSameAgentAndMessage();
  await creation.expectAgentCount(1);
});

test("repeated new-workspace prompt submissions create one workspace and one agent", async ({
  creation,
}) => {
  await creation.openWorkspaceForm("local");
  await creation.submitRepeatedly("Create", "Start one agent in one new workspace.");
  await creation.expectPromptVisible();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

test("separate drafts can intentionally create two agents in the same workspace", async ({
  creation,
  delayedCreation,
}) => {
  await creation.openAgentDraft();
  await creation.submitPrompt("Start the first agent.");
  await creation.expectPromptVisible("Start the first agent.");
  await delayedCreation.waitForDelayedCreatedStatus();
  await creation.startAnotherDraft();
  await creation.submitPrompt("Start the second agent.");
  await creation.expectPromptVisible("Start the second agent.");
  await delayedCreation.waitForDelayedCreatedStatus();
  delayedCreation.release();
  await creation.expectAgentCount(2);
});

test("new workspace navigation and optimistic prompt precede agent initialization", async ({
  creation,
  startup,
  delayedCreation,
}) => {
  await creation.openWorkspaceForm("worktree");
  await creation.submitPrompt("Show this prompt while the agent is starting.", "Create");
  await creation.expectAgentStillStarting();
  delayedCreation.expectSingleWorkspaceIntent();
  delayedCreation.release();
  await startup.release();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

for (const scenario of [
  { suffix: "", prepare: async () => {} },
  {
    suffix: " after remount",
    prepare: async (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.evictAndReturnToDraft(),
  },
]) {
  test(`retrying failed agent initialization preserves its workspace${scenario.suffix}`, async ({
    creation,
    startup,
    page,
  }) => {
    await creation.openWorkspaceForm("local");
    await creation.submitPrompt("Retry this workspace and agent together.", "Create");
    await creation.expectAgentStillStarting();
    await startup.fail();
    await creation.expectStartupFailure();
    await expect(page.getByTestId("app-toast")).toHaveCount(0);
    await creation.expectOneCreatedWorkspace();
    await scenario.prepare(creation);
    await creation.submitPrompt("Retry this workspace and agent together.");
    await creation.expectAgentCount(1);
  });

  test(`an edited prompt after failed agent initialization starts the agent in its workspace${scenario.suffix}`, async ({
    creation,
    startup,
    page,
  }) => {
    await creation.openWorkspaceForm("local");
    await creation.submitPrompt("Start the original task.", "Create");
    await creation.expectAgentStillStarting();
    await startup.fail();
    await creation.expectStartupFailure();
    await creation.expectOneCreatedWorkspace();
    await scenario.prepare(creation);
    await creation.submitPrompt("Start the edited task.");
    await creation.expectPromptVisible("Start the edited task.");
    await creation.expectOneCreatedWorkspace();
    await creation.expectAgentCount(1);
    await expect(page.getByText(/request_key_conflict/)).toHaveCount(0);
  });
}

test("retrying failed agent initialization keeps the plugin metadata set on New workspace", async ({
  creation,
  startup,
  composerMetadata,
}) => {
  await creation.openWorkspaceForm("local");
  await composerMetadata.set({ "composer-metadata.tag": "kept" });
  await creation.submitPrompt("Start the tagged task.", "Create");
  await creation.expectAgentStillStarting();
  await startup.fail();
  await creation.expectStartupFailure();
  await creation.expectOneCreatedWorkspace();
  await creation.submitPrompt("Start the tagged task.");
  await creation.expectAgentCount(1);
  await creation.expectAgentMetadata({ "composer-metadata.tag": "kept" });
});

test("an edited agent draft starts after its first start failed", async ({
  creation,
  startup,
  page,
}) => {
  await creation.openAgentDraft();
  await startup.fail();
  await creation.submitPrompt("Start the original task.");
  await creation.expectStartupFailure();
  await creation.submitPrompt("Start the edited task.");
  await creation.expectPromptVisible("Start the edited task.");
  await creation.expectAgentCount(1);
  await expect(page.getByText(/request_key_conflict/)).toHaveCount(0);
});

test("editing a failed New workspace submission starts without a request key conflict", async ({
  page,
}) => {
  // An empty git repository naturally rejects worktree creation before workspace_ready.
  const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-empty-git-ws-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  const client = await connectNewWorkspaceDaemonClient();
  let projectId: string | null = null;
  try {
    const seeded = await client.createWorkspace({
      source: { kind: "directory", path: repoDir },
    });
    if (!seeded.workspace) throw new Error(seeded.error ?? "Failed to seed empty git project");
    projectId = seeded.workspace.projectId;
    const listed = await client.listProjects();
    const project = listed.projects.find((entry) => entry.projectId === projectId);
    if (!project?.projectKey) throw new Error("Seeded project has no projectKey");

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: project.projectKey,
      projectDisplayName: seeded.workspace.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await fillComposerDraft(page, "Start original worktree task.");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const composerError = page.getByTestId("composer-error").filter({ visible: true }).first();
    await expect(composerError).toContainText("Unable to resolve repository default branch");
    // The failure renders once in the composer alert, not duplicated in a top toast.
    await expect(page.getByText("Unable to resolve repository default branch")).toHaveCount(1);

    await selectWorkspaceIsolation(page, "local");
    await fillComposerDraft(page, "hi");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(/\/workspace\//);
    await expect(page.getByText(/request_key_conflict/)).toHaveCount(0);
    await expect(
      page.getByTestId("user-message").filter({ hasText: "hi", visible: true }),
    ).toBeVisible();
  } finally {
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
    await client.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("switching only the launch target after a failed New workspace creation starts a new workspace", async ({
  creation,
  workspaceProvision,
  page,
}) => {
  const profiles = await seedTerminalProfiles([
    {
      id: "promptless-shell",
      name: "Promptless Shell",
      command: "sh",
      args: ["-c", "echo ready; sleep 5"],
      promptArg: "none",
    },
  ]);
  try {
    await creation.openWorkspaceForm("local");
    await workspaceProvision.fail();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByTestId("composer-error").filter({ visible: true }).first(),
    ).toContainText("Workspace provisioning failed for test");

    await selectLaunchOption(page, "promptless-shell");
    await submitTerminalLaunch(page);
    await creation.expectOneCreatedWorkspace();
    await expect(
      page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }).first(),
    ).toBeVisible();
  } finally {
    await profiles.restore();
  }
});

test("failing New workspace creation after switching workspaces shows an error toast", async ({
  creation,
  workspaceProvision,
  page,
}) => {
  await creation.openWorkspaceForm("local");
  await workspaceProvision.hold();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator('[data-testid^="sidebar-workspace-row-"]').first().click();
  await expect(page).toHaveURL(/\/workspace\//);

  await workspaceProvision.fail();
  await expect(page.getByTestId("app-toast")).toContainText(
    "Workspace provisioning failed for test",
  );
});

for (const entry of [
  {
    name: "agent draft",
    open: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.openAgentDraft(),
    button: "Send message",
    settled: async (_creation: Awaited<ReturnType<typeof createCreationScenario>>) => {},
  },
  {
    name: "new workspace",
    open: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.openWorkspaceForm("local"),
    button: "Create",
    settled: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.expectOneCreatedWorkspace(),
  },
]) {
  test(`${entry.name} becomes an agent tab when the first prompt is rejected`, async ({
    creation,
    promptRejection,
    page,
  }, testInfo) => {
    void promptRejection;
    const prompt =
      "Continue the attached conversation.\n" + "Earlier conversation context.\n".repeat(100);
    await entry.open(creation);
    await creation.submitPrompt(prompt, entry.button);
    await entry.settled(creation);
    await creation.expectCreatedAgentError();
    await creation.expectPromptBeforeError(prompt);
    await page.screenshot({
      path: testInfo.outputPath("created-agent-prompt-error.png"),
    });
    await creation.reloadAgent();
    await creation.expectPromptBeforeError(prompt);
    await creation.submitPrompt("emit 1 coalesced agent stream updates for a corrected prompt.");
    await creation.expectPromptVisible(
      "emit 1 coalesced agent stream updates for a corrected prompt.",
    );
    await creation.expectAssistantReply();
    await creation.expectAgentCount(1);
    await expect(page.getByText("agent_request_key_conflict", { exact: true })).toHaveCount(0);
  });
}
