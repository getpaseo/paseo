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

test("new workspace navigation and optimistic prompt precede agent completion", async ({
  creation,
  delayedCreation,
}) => {
  await creation.openWorkspaceForm("worktree");
  await creation.submitPrompt("Show this prompt while the agent is starting.", "Create");
  await delayedCreation.waitForDelayedCreatedStatus();
  await creation.expectWorkspaceReadyBeforeAgentCompletion();
  delayedCreation.expectSingleWorkspaceIntent();
  delayedCreation.release();
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});

test("retrying a failed combined result keeps the workspace and original creation intent", async ({
  creation,
  delayedCreation,
}) => {
  await creation.openWorkspaceForm("local");
  await creation.submitPrompt("Retry this workspace and agent together.", "Create");
  await delayedCreation.waitForDelayedCreatedStatus();
  await creation.expectWorkspaceReadyBeforeAgentCompletion();
  delayedCreation.fail("Creation response was lost");
  await creation.submitPrompt("Retry this workspace and agent together.");
  await creation.expectOneCreatedWorkspace();
  await creation.expectAgentCount(1);
});
