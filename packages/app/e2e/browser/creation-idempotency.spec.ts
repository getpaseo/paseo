import { expectPickerSelected } from "../support/helpers/new-workspace";
import {
  hideCreationLifecycle,
  holdWorkspaceProvisioning,
  reportUnknownPromptOutcome,
} from "../support/helpers/creation";
import type { createCreationScenario } from "../support/helpers/creation";
import { expectComposerMode, expectComposerModel } from "../support/helpers/agent-profiles";
import { expectChatHistoryAttachment } from "../support/helpers/assistant-fork";
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

for (const entry of [
  {
    name: "an agent draft",
    open: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.openAgentDraft(),
    button: "Send message",
    expectWorkspace: async (_creation: Awaited<ReturnType<typeof createCreationScenario>>) => {},
  },
  {
    name: "a new workspace",
    open: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.openWorkspaceForm("local"),
    button: "Create",
    expectWorkspace: (creation: Awaited<ReturnType<typeof createCreationScenario>>) =>
      creation.expectOneCreatedWorkspace(),
  },
]) {
  test(`a failed agent start in ${entry.name} keeps the draft, its error and its retry`, async ({
    creation,
    startup,
    page,
  }, testInfo) => {
    const prompt = "Retry this agent after its startup fails.";
    await entry.open(creation);
    await creation.submitPrompt(prompt, entry.button);
    await startup.fail();
    await creation.expectFailedAgentDraft(prompt);
    await entry.expectWorkspace(creation);
    await page.screenshot({ path: testInfo.outputPath("failed-agent-draft.png") });
    await creation.resendFailedDraft();
    await creation.expectPromptVisible(prompt);
    await entry.expectWorkspace(creation);
    await creation.expectAgentCount(1);
  });
}

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
    await page.screenshot({ path: testInfo.outputPath("created-agent-prompt-error.png") });
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

for (const isolation of ["local", "worktree"] as const) {
  test(`a held ${isolation} workspace opens the normal agent panel and queues a follow-up`, async ({
    creation,
    page,
  }, testInfo) => {
    const prompt = "emit 1 coalesced agent stream updates for the first workspace prompt.";
    const followUp = "emit 1 coalesced agent stream updates for the queued follow-up.";
    const draft = "Keep this unsent draft through adoption.";
    const provisioning = await holdWorkspaceProvisioning(page);
    await creation.openWorkspaceForm(isolation);
    await creation.submitPrompt(prompt, "Create");
    const request = await provisioning.waitForRequest();

    await test.step("the final agent panel paints before any host response", async () => {
      expect(request.workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
      expect(request.agent!.agentId).toMatch(/^[a-f0-9-]{36}$/);
      await expect(page).toHaveURL(new RegExp(`/workspace/${request.workspaceId}$`));
      await expect(
        page.getByTestId(`workspace-tab-agent_${request.agent!.agentId}`).filter({ visible: true }),
      ).toBeVisible();
      await creation.expectPromptVisible(prompt);
      await creation.expectNormalAgentComposer();
      await expectComposerModel(page, "Ten second stream");
      await expectComposerMode(page, "Load test");
    });

    await test.step("a follow-up waits in the queue instead of reaching the agent", async () => {
      await creation.queueFollowUp(followUp);
      await creation.typeComposerDraft(draft);
      expect(provisioning.agentPrompts()).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("held-normal-panel.png") });
    });

    await test.step("adoption keeps the same agent, draft and queue order", async () => {
      provisioning.release();
      await creation.expectOneCreatedWorkspace();
      expect(await creation.agentIds()).toEqual([request.agent!.agentId]);
      await expect(page).toHaveURL(new RegExp(`/workspace/${request.workspaceId}$`));
      await creation.expectUserMessagesInOrder([prompt, followUp]);
      expect(provisioning.agentPrompts()).toBe(1);
      await creation.expectComposerDraft(draft);
      await creation.expectTimelineSettled();
      await page.screenshot({ path: testInfo.outputPath("adopted-normal-panel.png") });
    });
  });
}

test("a held workspace on compact shows the final agent prompt and composer", async ({
  creation,
  page,
}, testInfo) => {
  const provisioning = await holdWorkspaceProvisioning(page);
  await creation.openWorkspaceForm("worktree");
  await page.setViewportSize({ width: 390, height: 844 });
  await creation.submitPrompt("Show my prompt before workspace provisioning.", "Create");
  const request = await provisioning.waitForRequest();
  await expect(page).toHaveURL(new RegExp(`/workspace/${request.workspaceId}$`));
  await creation.expectPromptVisible("Show my prompt before workspace provisioning.");
  await creation.expectNormalAgentComposer();
  await creation.expectAgentCannotBeStoppedYet();
  await page.screenshot({ path: testInfo.outputPath("compact-held.png") });
  provisioning.release();
  await creation.expectOneCreatedWorkspace();
  expect(await creation.agentIds()).toEqual([request.agent!.agentId]);
  await creation.expectInitialPromptOnce("Show my prompt before workspace provisioning.");
});

test("workspace creation recovers a lost response without replaying the first prompt", async ({
  creation,
  workspacePromptRetry,
}) => {
  await creation.openWorkspaceForm("worktree");
  workspacePromptRetry.holdAcknowledgement();
  await creation.submitPrompt("Recover this workspace prompt once.", "Create");
  await workspacePromptRetry.waitForDeliveredPrompt();
  await creation.expectPromptVisible("Recover this workspace prompt once.");
  await creation.evictAndReturnToDraft();
  await workspacePromptRetry.disconnectAndReconnect();
  await workspacePromptRetry.expectSameAgentAndMessage();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

test("a pending workspace survives leaving and remounting before any daemon event", async ({
  creation,
  page,
}) => {
  const provisioning = await holdWorkspaceProvisioning(page);
  await creation.openWorkspaceForm("worktree");
  await creation.submitPrompt("Keep this pending workspace across remount.", "Create");
  await provisioning.waitForRequest();
  await creation.expectPromptVisible("Keep this pending workspace across remount.");
  await creation.evictAndReturnToDraft();
  await creation.expectPromptVisible("Keep this pending workspace across remount.");
  provisioning.release();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

test("a failed workspace returns to New workspace with the prompt and its error", async ({
  creation,
  provisioningFailure,
  page,
}, testInfo) => {
  const prompt = "Keep my prompt when the workspace fails.";
  await provisioningFailure.arm();
  await creation.openWorkspaceForm("local");
  await creation.submitRepeatedly("Create", prompt);
  await creation.expectReturnedToNewWorkspace(prompt, "Provisioning outcome is uncertain for test");
  await page.screenshot({ path: testInfo.outputPath("failed-workspace-returned.png") });
});

test("a failed workspace preserves its non-default branch through resubmission", async ({
  creation,
  provisioningFailure,
  page,
}) => {
  const prompt = "Keep the selected worktree base when provisioning fails.";
  const provisioning = await holdWorkspaceProvisioning(page);
  await creation.openWorkspaceForm("worktree");
  await creation.selectWorktreeBranch("recovery-base");
  await provisioningFailure.arm();
  await creation.submitPrompt(prompt, "Create");
  const first = await provisioning.waitForRequest();
  expect(first.source).toMatchObject({
    kind: "worktree",
    action: "branch-off",
    refName: "refs/heads/recovery-base",
  });
  provisioning.release();
  await creation.expectReturnedToNewWorkspace(prompt, "Provisioning outcome is uncertain for test");

  await expectPickerSelected(page, "recovery-base");
  await creation.resubmitWorkspace();
  const second = await provisioning.waitForRequests(2);
  expect(second.source).toMatchObject({
    kind: "worktree",
    action: "branch-off",
    refName: "refs/heads/recovery-base",
  });
  provisioning.release();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

test("a failed workspace keeps its queued follow-up and unsent text through resubmission", async ({
  creation,
  provisioningFailure,
  page,
}, testInfo) => {
  const prompt = "emit 1 coalesced agent stream updates for the resubmitted workspace.";
  const followUp = "emit 1 coalesced agent stream updates for the resubmitted follow-up.";
  const draft = "Keep this unsent text through the failed workspace.";
  await provisioningFailure.arm();
  const provisioning = await holdWorkspaceProvisioning(page);
  await creation.openWorkspaceForm("local");
  await creation.submitPrompt(prompt, "Create");
  await provisioning.waitForRequest();
  await creation.queueFollowUp(followUp);
  await creation.typeComposerDraft(draft);
  provisioning.release();

  await test.step("New workspace shows the prompt, its error and the queued follow-up", async () => {
    await creation.expectReturnedToNewWorkspace(
      prompt,
      "Provisioning outcome is uncertain for test",
    );
    await creation.expectQueuedFollowUp(followUp);
    await page.screenshot({ path: testInfo.outputPath("failed-workspace-follow-up.png") });
  });

  await test.step("resubmitting delivers the prompt, then the follow-up, once", async () => {
    await creation.resubmitWorkspace();
    await provisioning.waitForRequests(2);
    provisioning.release();
    await creation.expectOneCreatedWorkspace();
    await creation.expectAgentCount(1);
    await creation.expectUserMessagesInOrder([prompt, followUp]);
    await creation.expectComposerDraft(draft);
    await page.screenshot({ path: testInfo.outputPath("resubmitted-workspace-follow-up.png") });
  });
});

test("a failed agent start keeps its queued follow-up and unsent text through retry", async ({
  creation,
  startup,
  page,
}, testInfo) => {
  const prompt = "emit 1 coalesced agent stream updates for the retried agent.";
  const followUp = "emit 1 coalesced agent stream updates for the retried follow-up.";
  const draft = "Keep this unsent text through the failed agent start.";
  await creation.openWorkspaceForm("local");
  await creation.submitPrompt(prompt, "Create");
  await creation.queueFollowUp(followUp);
  await creation.typeComposerDraft(draft);
  await startup.fail();

  await test.step("the agent draft shows the prompt, its error and the queued follow-up", async () => {
    await creation.expectFailedAgentDraft(prompt);
    await creation.expectQueuedFollowUp(followUp);
    await page.screenshot({ path: testInfo.outputPath("failed-agent-follow-up.png") });
  });

  await test.step("retrying delivers the prompt, then the follow-up, once", async () => {
    await creation.resendFailedDraft();
    await creation.expectOneCreatedWorkspace();
    await creation.expectAgentCount(1);
    await creation.expectUserMessagesInOrder([prompt, followUp]);
    await creation.expectComposerDraft(draft);
    await page.screenshot({ path: testInfo.outputPath("retried-agent-follow-up.png") });
  });
});

test("a forked worktree agent that fails to start keeps its setup and context through retry", async ({
  creation,
  lateStartup,
  page,
}, testInfo) => {
  const prompt = "Keep this fork's setup, image and history through the retry.";
  await creation.openNestedAgentFork("worktree");
  await creation.attachImage();
  const startup = await lateStartup.arm();
  await creation.submitPrompt(prompt, "Create");
  await startup.fail();

  await test.step("the agent draft keeps the fork's configuration and context", async () => {
    await creation.expectFailedAgentDraft(prompt);
    await expectComposerModel(page, "e2e-fast-stream");
    await expectComposerMode(page, "Load test");
    await creation.expectImageVisible();
    await expectChatHistoryAttachment(page);
    await page.screenshot({ path: testInfo.outputPath("failed-fork-draft.png") });
  });

  // An agent created in an existing workspace starts at the workspace root: the host ignores
  // config.cwd when the request names a workspace, so the nested cwd is not asserted here.
  await test.step("retrying creates one agent in the worktree with that configuration and context", async () => {
    await creation.resendFailedDraft();
    await creation.expectOneCreatedWorkspace();
    await creation.expectAgentCount(1);
    await creation.expectAgentConfig({ model: "e2e-fast-stream", modeId: "load-test" });
    await creation.expectImageVisible();
    await expect(
      page
        .getByTestId("user-message")
        .filter({ hasText: "Chat history" })
        .filter({ visible: true }),
    ).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("retried-fork-agent.png") });
  });
});

test("a forked worktree whose workspace fails keeps its context through resubmission", async ({
  creation,
  provisioningFailure,
  page,
}, testInfo) => {
  const prompt = "Keep this fork's history when its workspace fails.";
  await creation.openNestedAgentFork("worktree");
  await provisioningFailure.arm();
  await creation.submitPrompt(prompt, "Create");

  await test.step("New workspace shows the prompt, its error and the fork's context", async () => {
    await creation.expectReturnedToNewWorkspace(
      prompt,
      "Provisioning outcome is uncertain for test",
    );
    await expectChatHistoryAttachment(page);
    await page.screenshot({ path: testInfo.outputPath("failed-fork-workspace.png") });
  });

  await test.step("resubmitting creates one agent with that context", async () => {
    await creation.resubmitWorkspace();
    await creation.expectOneCreatedWorkspace();
    await creation.expectAgentCount(1);
    await expect(
      page
        .getByTestId("user-message")
        .filter({ hasText: "Chat history" })
        .filter({ visible: true }),
    ).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("resubmitted-fork-workspace.png") });
  });
});

test("an unsupported host keeps the draft and asks for an update before creating anything", async ({
  creation,
  page,
}) => {
  const host = await hideCreationLifecycle(page);
  await creation.openWorkspaceForm("local");
  await creation.submitPrompt("Retain my unsupported host draft.", "Create");
  await expect(
    page
      .getByText("Update this host to create a workspace with an agent.", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/new\?/);
  host.expectNoCreationRequest();
});

for (const isolation of ["local", "worktree"] as const) {
  test(`a fork keeps its image and nested cwd in the optimistic and real ${isolation} agent`, async ({
    creation,
    page,
  }, testInfo) => {
    const provisioning = await holdWorkspaceProvisioning(page);
    const cwd = await creation.openNestedAgentFork(isolation);
    await creation.attachImage();
    await creation.submitPrompt("Keep this image and nested cwd.", "Create");
    const request = await provisioning.waitForRequest();
    expect(request.agent!.config?.cwd).toBe(cwd);
    expect(request.agent!.images).toHaveLength(1);
    await creation.expectPromptVisible("Keep this image and nested cwd.");
    await creation.expectImageVisible();
    await page.screenshot({ path: testInfo.outputPath("pending-image-nested-cwd.png") });
    provisioning.release();
    await creation.expectOneCreatedWorkspace();
    await creation.expectNestedAgentCwd();
    await creation.expectImageVisible();
    await creation.expectInitialPromptOnce("Keep this image and nested cwd.");
  });
}

test("closing the pending agent tab leaves host creation running", async ({ creation, page }) => {
  const provisioning = await holdWorkspaceProvisioning(page);
  await creation.openWorkspaceForm("local");
  await creation.submitPrompt("Finish creation after I close the tab.", "Create");
  const request = await provisioning.waitForRequest();
  await creation.expectPromptVisible("Finish creation after I close the tab.");
  await creation.closePendingAgent(request.agent!.agentId!);
  provisioning.release();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
  await creation.expectInitialPromptOnce("Finish creation after I close the tab.");
});

test("an uncertain prompt receipt keeps the created agent tab and its timeline", async ({
  creation,
  page,
}) => {
  await reportUnknownPromptOutcome(page);
  await creation.openWorkspaceForm("local");
  const prompt = "emit 1 coalesced agent stream updates for an uncertain first prompt.";
  await creation.submitPrompt(prompt, "Create");
  await creation.expectAssistantReply();
  await creation.expectAgentNotWorking();
  await creation.expectOneCreatedWorkspace();
  await creation.expectInitialPromptOnce(prompt);
  await creation.expectNoCreationRecovery();
  await creation.expectAgentCount(1);
});
