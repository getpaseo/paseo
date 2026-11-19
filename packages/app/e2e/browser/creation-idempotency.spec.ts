import { useCreationProtocol, type createCreationScenario } from "../support/helpers/creation";
import { expect } from "../support/fixtures";
import { test } from "../support/creation-fixtures";
import {
  delayBrowserWorkspaceCreatedResponse,
  selectWorkspaceIsolation,
  connectNewWorkspaceDaemonClient,
} from "../support/helpers/new-workspace";
import { selectLaunchOption, submitTerminalLaunch } from "../support/helpers/new-workspace-launch";

test("an uncertain background agent cannot lose its identity through a terminal launch after reload", async ({
  creation,
  startup,
  page,
}) => {
  test.setTimeout(90_000);
  const delay = await delayBrowserWorkspaceCreatedResponse(page);
  const client = await connectNewWorkspaceDaemonClient();
  try {
    await creation.openWorkspaceForm("local");
    const before = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
    await creation.submitPrompt("Reconcile the original uncertain start", "Create");
    await delay.waitForCreateRequest();
    await creation.leaveWorkspaceForm();
    delay.release();
    // Wait for the real checkpoint before discarding the original app instance.
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => {
        if (!key.startsWith("draft-creation:")) return false;
        const record = JSON.parse(localStorage.getItem(key)!);
        return (
          record.workspace &&
          record.attempt?.agentRequested === true &&
          record.attempt.outcome === "pending"
        );
      }),
    );
    await creation.returnToWorkspaceForm();
    await page.reload();
    await selectLaunchOption(page, "blank");
    await submitTerminalLaunch(page);
    await expect(
      page
        .getByText(
          "The previous start may still be running. Check your workspaces and agents before starting another.",
        )
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    const created = (await client.fetchWorkspaces()).entries.filter(
      (entry) => !before.has(entry.id),
    );
    expect(created).toHaveLength(1);
    expect(
      (
        await client.listTerminals(created[0]!.workspaceDirectory, undefined, {
          workspaceId: created[0]!.id,
        })
      ).terminals,
    ).toHaveLength(0);
    await startup.release();
    await selectLaunchOption(page, "chat");
    await creation.submitPrompt("Reconcile the original uncertain start", "Create");
    await creation.expectPromptVisible("Reconcile the original uncertain start");
    expect(
      (await client.fetchAgents()).entries.filter(
        (entry) => entry.agent.workspaceId === created[0]!.id,
      ),
    ).toHaveLength(1);
    expect(
      (await client.fetchWorkspaces()).entries
        .filter((entry) => !before.has(entry.id))
        .map((entry) => entry.id),
    ).toEqual([created[0]!.id]);
  } finally {
    delay.release();
    await startup.release();
    await client.close();
  }
});

const backgroundRecoveryScenarios: Array<{
  name: string;
  legacy: boolean;
  metadata: Record<string, string>;
}> = [
  { name: "modern metadata", legacy: false, metadata: { "composer-metadata.tag": "restored" } },
  { name: "legacy", legacy: true, metadata: {} },
];
for (const scenario of backgroundRecoveryScenarios) {
  test(`an edited background failure reuses its ready workspace after reload (${scenario.name})`, async ({
    creation,
    startup,
    composerMetadata,
    page,
  }) => {
    const delay = await delayBrowserWorkspaceCreatedResponse(page);
    try {
      await creation.openWorkspaceForm("local");
      await composerMetadata.set(scenario.metadata);
      await creation.submitPrompt("Original background task", "Create");
      await delay.waitForCreateRequest();
      await creation.leaveWorkspaceForm();
      await startup.fail();
      delay.release();
      await expect(
        page
          .getByText(/Creation startup failed for test/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await creation.expectOneCreatedWorkspace();
      const protocol = await useCreationProtocol(page, scenario.legacy);
      await creation.returnToWorkspaceForm();
      await page.reload();
      await selectWorkspaceIsolation(page, "worktree");
      await creation.submitPrompt("Edited background task", "Create");
      await expect(
        page
          .getByText(/Workspace placement has changed/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await creation.expectAgentCount(0);
      await creation.expectCreatedWorkspaceCount(1);
      await selectWorkspaceIsolation(page, "local");
      await creation.submitPrompt("Edited background task", "Create");
      await creation.expectPromptVisible("Edited background task");
      await creation.expectOneCreatedWorkspace();
      await creation.expectAgentCount(1);
      await creation.expectAgentMetadata(scenario.metadata);
      protocol.expectAgentRequest();
    } finally {
      delay.release();
    }
  });
}

test("successful empty workspace creation retires its draft identity across reloads", async ({
  creation,
  page,
}) => {
  await creation.openWorkspaceForm("local");
  await creation.submitRepeatedly("Create");
  await expect(page).toHaveURL(/\/workspace\//);
  const firstWorkspaceUrl = page.url();
  await creation.returnToWorkspaceForm();
  await page.reload();
  await creation.submitRepeatedly("Create");
  await expect(page).toHaveURL(/\/workspace\//);
  expect(page.url()).not.toBe(firstWorkspaceUrl);
  await creation.returnToWorkspaceForm();
  await page.reload();
  await creation.submitPrompt("Chat after two empty workspaces", "Create");
  await creation.expectPromptVisible("Chat after two empty workspaces");
});

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
  }) => {
    await creation.openWorkspaceForm("local");
    await creation.submitPrompt("Retry this workspace and agent together.", "Create");
    await creation.expectAgentStillStarting();
    await startup.fail();
    await creation.expectStartupFailure();
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
