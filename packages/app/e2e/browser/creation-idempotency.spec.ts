import { draftCreationKey } from "../../src/composer/draft/creation-key";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { reselectModel } from "../support/helpers/model-memory";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  attachComposerTestImage,
  expectAttachmentPill,
  fillComposerDraft,
} from "../support/helpers/composer";
import { getServerId } from "../support/helpers/server-id";
import { useCreationProtocol, type createCreationScenario } from "../support/helpers/creation";
import { expect } from "../support/fixtures";
import { test } from "../support/creation-fixtures";
import {
  delayBrowserWorkspaceCreatedResponse,
  selectWorkspaceIsolation,
  connectNewWorkspaceDaemonClient,
  loadSessionMessageReaders,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import {
  selectLaunchOption,
  submitTerminalLaunch,
  terminalLaunchSubmit,
  expectWorkspaceOpensWithTerminalTab,
  seedTerminalProfiles,
  holdTerminalCreationResponse,
  pauseNextImageEncoding,
} from "../support/helpers/new-workspace-launch";

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
    await expect(terminalLaunchSubmit(page)).toBeDisabled();
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
    await expectWorkspaceOpensWithTerminalTab(page);
    await creation.returnToWorkspaceForm();
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

test("editing a New workspace with an uncertain provisioning failure cannot create a duplicate", async ({
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

    await expect(composerError).toContainText("The previous start may still be running.");
    await expect(page.getByText(/request_key_conflict/)).toHaveCount(0);
    expect(
      (await client.fetchWorkspaces()).entries
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => entry.id),
    ).toEqual([seeded.workspace.id]);
  } finally {
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
    await client.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("switching only the launch target after a failed New workspace creation starts a new workspace", async ({
  creation,
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
  let restoreDirectory: (() => void) | undefined;
  try {
    await creation.openWorkspaceForm("local");
    const directory = new URL(page.url()).searchParams.get("dir");
    if (!directory) throw new Error("Workspace form has no project directory");
    const displaced = `${directory}-temporarily-missing`;
    // Missing source is a conclusive rejection; a generic provisioning error can be uncertain.
    renameSync(directory, displaced);
    restoreDirectory = () => renameSync(displaced, directory);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByTestId("composer-error").filter({ visible: true }).first(),
    ).toContainText("Directory not found");
    restoreDirectory();
    restoreDirectory = undefined;

    await selectLaunchOption(page, "promptless-shell");
    await submitTerminalLaunch(page);
    await creation.expectOneCreatedWorkspace();
    await expect(
      page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }).first(),
    ).toBeVisible();
  } finally {
    restoreDirectory?.();
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

for (const outcome of ["completed", "failed"] as const) {
  test(`a handed-off workspace receipt reconciles after reload when startup ${outcome}`, async ({
    creation,
    startup,
    page,
  }) => {
    test.setTimeout(90_000);
    const frames = await loadSessionMessageReaders();
    const receipts: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const request = frames.client(payload);
        if (request?.type === "creation.subscribe.request" && request.kind === "workspace")
          receipts.push(request.idempotencyKey);
      }),
    );
    const client = await connectNewWorkspaceDaemonClient();
    try {
      await creation.openWorkspaceForm("local");
      const before = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
      await creation.submitPrompt("Original handed-off task", "Create");
      await creation.expectAgentStillStarting();
      await page.reload();
      if (outcome === "failed") await startup.fail();
      else await startup.release();
      const prompt =
        outcome === "failed" ? "Corrected handed-off task" : "Original handed-off task";
      await creation.submitPrompt(prompt);
      await creation.expectPromptVisible(prompt);
      expect(receipts).toHaveLength(1);
      const created = (await client.fetchWorkspaces()).entries.filter(
        (entry) => !before.has(entry.id),
      );
      expect(created).toHaveLength(1);
      expect(
        (await client.fetchAgents()).entries.filter(
          (entry) => entry.agent.workspaceId === created[0]!.id,
        ),
      ).toHaveLength(1);
    } finally {
      await startup.release();
      await client.close();
    }
  });
}

test("chat admission keeps its prepared ID when a late terminal retires it during image encoding", async ({
  creation,
  startup,
  page,
}) => {
  test.setTimeout(120_000);
  const terminal = await holdTerminalCreationResponse(page);
  const client = await connectNewWorkspaceDaemonClient();
  let encoding: Awaited<ReturnType<typeof pauseNextImageEncoding>> | undefined;
  try {
    await creation.openWorkspaceForm("local");
    const before = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
    await fillComposerDraft(page, "Prepared chat with image");
    await attachComposerTestImage(page);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await selectLaunchOption(page, "blank");
    await submitTerminalLaunch(page);
    await terminal.wait();
    const scopeKey = JSON.stringify([getServerId(), "new-workspace"]);
    const preparedId = await page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem("paseo-drafts")!).state.creationIdByDraftKey[key] as string,
      scopeKey,
    );
    await creation.leaveWorkspaceForm();
    await creation.returnToWorkspaceForm();
    await selectLaunchOption(page, "chat");
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    encoding = await pauseNextImageEncoding(page);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await encoding.wait();
    terminal.release();
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem("paseo-drafts")!).state.creationIdByDraftKey[key] === null,
      scopeKey,
    );
    await encoding.release();
    await creation.expectAgentStillStarting();
    const operation = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(`draft-creation:${key}`)!),
      JSON.stringify([getServerId(), preparedId]),
    );
    expect(operation.attempt.kind).toBe("agent");
    const created = (await client.fetchWorkspaces()).entries.filter(
      (entry) => !before.has(entry.id),
    );
    expect(created).toHaveLength(1);
    await page.reload();
    await attachComposerTestImage(page);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await startup.release();
    await creation.submitPrompt("Prepared chat with image");
    await creation.expectPromptVisible("Prepared chat with image");
    expect(
      (await client.fetchWorkspaces()).entries
        .filter((entry) => !before.has(entry.id))
        .map((entry) => entry.id),
    ).toEqual([created[0]!.id]);
    expect(
      (await client.fetchAgents()).entries.filter(
        (entry) => entry.agent.workspaceId === created[0]!.id,
      ),
    ).toHaveLength(1);
  } finally {
    terminal.release();
    await encoding?.release();
    await startup.release();
    await client.close();
  }
});

test("a completed background creation releases its identity while preserving a newer prompt across reload", async ({
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
    await creation.submitPrompt("Original background idea", "Create");
    await delay.waitForCreateRequest();
    await creation.leaveWorkspaceForm();
    delay.release();
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => {
        if (!key.startsWith("draft-creation:")) return false;
        const record = JSON.parse(localStorage.getItem(key)!);
        return record.workspace && record.attempt?.outcome === "pending";
      }),
    );
    await creation.returnToWorkspaceForm();
    await fillComposerDraft(page, "A newer independent idea");
    await startup.release();
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem("paseo-drafts")!).state.creationIdByDraftKey[key] === null,
      JSON.stringify([getServerId(), "new-workspace"]),
    );
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }).first(),
    ).toHaveText("A newer independent idea");
    await creation.submitPrompt("A newer independent idea", "Create");
    await creation.expectPromptVisible("A newer independent idea");
    const workspaces = (await client.fetchWorkspaces()).entries.filter(
      (entry) => !before.has(entry.id),
    );
    expect(workspaces).toHaveLength(2);
    const agents = (await client.fetchAgents()).entries.filter((entry) =>
      workspaces.some((workspace) => workspace.id === entry.agent.workspaceId),
    );
    expect(agents).toHaveLength(2);
    expect(new Set(agents.map((entry) => entry.agent.workspaceId)).size).toBe(2);
  } finally {
    delay.release();
    await startup.release();
    await client.close();
  }
});

for (const target of ["terminal", "empty"] as const) {
  test(`successful ${target} reuse after conclusive Chat startup failure retires the identity across reload`, async ({
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
      await creation.submitPrompt("Original failed Chat task", "Create");
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
      const original = (await client.fetchWorkspaces()).entries.filter(
        (entry) => !before.has(entry.id),
      );
      expect(original).toHaveLength(1);
      expect(
        (await client.fetchAgents()).entries.filter(
          (entry) => entry.agent.workspaceId === original[0]!.id,
        ),
      ).toHaveLength(0);
      await creation.returnToWorkspaceForm();
      await page.reload();
      if (target === "terminal") {
        await selectLaunchOption(page, "blank");
        await submitTerminalLaunch(page);
      } else {
        await fillComposerDraft(page, "");
        await page.getByRole("button", { name: "Create", exact: true }).click();
      }
      await creation.expectOneCreatedWorkspace();
      await page.waitForFunction(
        (key) =>
          JSON.parse(localStorage.getItem("paseo-drafts")!).state.creationIdByDraftKey[key] ===
          null,
        JSON.stringify([getServerId(), "new-workspace"]),
      );
      await creation.returnToWorkspaceForm();
      await page.reload();
      await selectLaunchOption(page, "chat");
      await creation.submitPrompt(`Independent Chat after ${target}`, "Create");
      await creation.expectPromptVisible(`Independent Chat after ${target}`);
      const workspaces = (await client.fetchWorkspaces()).entries.filter(
        (entry) => !before.has(entry.id),
      );
      expect(workspaces).toHaveLength(2);
      const fresh = workspaces.find((entry) => entry.id !== original[0]!.id)!;
      const createdIds = new Set(workspaces.map((workspace) => workspace.id));
      await expect
        .poll(async () =>
          (await client.fetchAgents()).entries
            .filter((entry) => createdIds.has(entry.agent.workspaceId ?? ""))
            .map((entry) => entry.agent.workspaceId),
        )
        .toEqual([fresh.id]);
    } finally {
      delay.release();
      await startup.release();
      await client.close();
    }
  });
}

for (const isolation of ["local", "worktree"] as const) {
  test(`repeated empty ${isolation} Create clicks provision once on a legacy host without workspace receipts`, async ({
    creation,
    page,
  }) => {
    await useCreationProtocol(page, true, { workspaceRequestReceipts: false });
    await creation.openWorkspaceForm(isolation);
    await creation.submitRepeatedly("Create");
    await creation.expectOneCreatedWorkspace();
    await page.reload();
    await creation.expectOneCreatedWorkspace();
  });
}

for (const outcome of ["failed", "completed"] as const) {
  test(`an edited source draft reconciles its pending workspace receipt after reload when startup ${outcome}`, async ({
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
      await creation.submitPrompt("Original source task before reload", "Create");
      await delay.waitForCreateRequest();
      await creation.leaveWorkspaceForm();
      delay.release();
      await page.waitForFunction(() =>
        Object.keys(localStorage).some((key) => {
          if (!key.startsWith("draft-creation:")) return false;
          const record = JSON.parse(localStorage.getItem(key)!);
          return (
            record.workspace &&
            record.attempt?.kind === "workspace" &&
            record.attempt.outcome === "pending"
          );
        }),
      );
      await creation.returnToWorkspaceForm();
      await page.reload();
      await reselectModel(page, "mock", "Ten second stream");
      if (outcome === "failed") await startup.fail();
      else await startup.release();
      await creation.submitPrompt("Corrected source task after reload", "Create");
      if (outcome === "failed") {
        await creation.expectPromptVisible("Corrected source task after reload");
      } else {
        await expect(
          page
            .getByText(
              "The previous start may still be running. Check your workspaces and agents before starting another.",
            )
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
      }
      const workspaces = (await client.fetchWorkspaces()).entries.filter(
        (entry) => !before.has(entry.id),
      );
      expect(workspaces).toHaveLength(1);
      await expect
        .poll(
          async () =>
            (await client.fetchAgents()).entries.filter(
              (entry) => entry.agent.workspaceId === workspaces[0]!.id,
            ).length,
        )
        .toBe(1);
    } finally {
      delay.release();
      await startup.release();
      await client.close();
    }
  });
}

test("an edited standalone agent draft observes its pending receipt after reload before retrying a failed startup", async ({
  creation,
  startup,
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  try {
    const before = new Set((await client.fetchAgents()).entries.map((entry) => entry.agent.id));
    await creation.openAgentDraft();
    await creation.submitPrompt("Original standalone task");
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => {
        if (!key.startsWith("draft-creation:")) return false;
        const record = JSON.parse(localStorage.getItem(key)!);
        return record.attempt?.kind === "agent" && record.attempt.outcome === "pending";
      }),
    );
    await page.reload();
    await reselectModel(page, "mock", "Ten second stream");
    await startup.fail();
    await creation.submitPrompt("Corrected standalone task");
    await creation.expectPromptVisible("Corrected standalone task");
    // Reload destroyed the original request's page; verify committed agents through the daemon.
    await expect
      .poll(
        async () =>
          (await client.fetchAgents()).entries.filter(
            (entry) => Boolean(entry.agent.workspaceId) && !before.has(entry.agent.id),
          ).length,
      )
      .toBe(1);
    await expect(page.getByText(/request_key_conflict/)).toHaveCount(0);
  } finally {
    await startup.release();
    await client.close();
  }
});

for (const outcome of ["failed", "completed"] as const) {
  test(`an edited source draft recovers its workspace receipt when reload loses readiness (${outcome})`, async ({
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
      await creation.submitPrompt("Original task before any ready checkpoint", "Create");
      await delay.waitForCreateRequest();
      await creation.leaveWorkspaceForm();
      await page.waitForFunction(() =>
        Object.keys(localStorage).some((key) => {
          if (!key.startsWith("draft-creation:")) return false;
          const record = JSON.parse(localStorage.getItem(key)!);
          return (
            !record.workspace &&
            record.attempt?.kind === "workspace" &&
            record.attempt.outcome === "pending"
          );
        }),
      );
      await creation.returnToWorkspaceForm();
      await page.reload();
      delay.release({ discard: true });
      await reselectModel(page, "mock", "Ten second stream");
      if (outcome === "failed") await startup.fail();
      else await startup.release();
      await creation.submitPrompt("Edited task after lost readiness", "Create");
      if (outcome === "failed")
        await creation.expectPromptVisible("Edited task after lost readiness");
      else
        await expect(
          page
            .getByText(
              "The previous start may still be running. Check your workspaces and agents before starting another.",
            )
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
      const workspaces = (await client.fetchWorkspaces()).entries.filter(
        (entry) => !before.has(entry.id),
      );
      expect(workspaces).toHaveLength(1);
      await expect
        .poll(
          async () =>
            (await client.fetchAgents()).entries.filter(
              (entry) => entry.agent.workspaceId === workspaces[0]!.id,
            ).length,
        )
        .toBe(1);
    } finally {
      delay.release({ discard: true });
      await startup.release();
      await client.close();
    }
  });
}

test("a retired explicit fork route uses a fresh creation scope when revisited after completion", async ({
  creation,
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const routeDraftId = "draft_explicit_fork_retry";
  try {
    await creation.openWorkspaceForm("local");
    const url = new URL(page.url());
    url.searchParams.set("draftId", routeDraftId);
    const route = `${url.pathname}${url.search}`;
    await page.goto(route);
    await selectWorkspaceIsolation(page, "local");
    await reselectModel(page, "mock", "Ten second stream");
    const before = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
    await creation.submitPrompt("Original explicit fork idea", "Create");
    await creation.expectPromptVisible("Original explicit fork idea");
    const scopeKey = JSON.stringify([getServerId(), `new-workspace:draft:${routeDraftId}`]);
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem("paseo-drafts")!).state.creationIdByDraftKey[key] === null,
      scopeKey,
    );
    await page.goto(route);
    await reselectModel(page, "mock", "Ten second stream");
    await creation.submitPrompt("A newer explicit fork idea", "Create");
    await creation.expectPromptVisible("A newer explicit fork idea");
    const workspaces = (await client.fetchWorkspaces()).entries.filter(
      (entry) => !before.has(entry.id),
    );
    expect(workspaces).toHaveLength(2);
    const ids = new Set(workspaces.map((workspace) => workspace.id));
    await expect
      .poll(
        async () =>
          (await client.fetchAgents()).entries.filter((entry) =>
            ids.has(entry.agent.workspaceId ?? ""),
          ).length,
      )
      .toBe(2);
  } finally {
    await client.close();
  }
});

test("an explicit local draft retains the pre-upgrade workspace key encoding without admission storage", async ({
  creation,
  startup,
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const routeDraftId = "draft_upgrade_workspace_key";
  const prompt = "Recover the pre-upgrade local start";
  const frames = await loadSessionMessageReaders();
  const submissions: Array<{ key: string | undefined; expected: string }> = [];
  let suppressReadiness = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const message = frames.client(frame);
      if (message?.type === "workspace.create.request") {
        const {
          type: _type,
          requestId: _requestId,
          subscribe: _subscribe,
          idempotencyKey,
          ...request
        } = message;
        // Wire validation adds empty labels; this draft did not submit labels.
        const { labels: _labels, ...agent } = request.agent!;
        submissions.push({
          key: idempotencyKey,
          expected: draftCreationKey(routeDraftId, {
            request: { ...request, agent },
            launchTarget: { kind: "chat" },
          }),
        });
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const message = frames.server(frame);
      if (
        suppressReadiness &&
        (message?.type === "workspace.create.update" ||
          message?.type === "workspace.create.response")
      )
        return;
      browser.send(frame);
    });
  });
  try {
    await creation.openWorkspaceForm("local");
    const url = new URL(page.url());
    url.searchParams.set("draftId", routeDraftId);
    await page.goto(`${url.pathname}${url.search}`);
    await reselectModel(page, "mock", "Ten second stream");
    const before = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
    await creation.submitPrompt(prompt, "Create");
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]!.key).toBe(submissions[0]!.expected);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter((entry) => !before.has(entry.id)).length,
      )
      .toBe(1);
    await page.waitForFunction(
      (text) => localStorage.getItem("paseo-drafts")?.includes(text),
      prompt,
    );
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("draft-creation:")) localStorage.removeItem(key);
      }
    });
    suppressReadiness = false;
    await page.reload();
    await reselectModel(page, "mock", "Ten second stream");
    await creation.submitPrompt(prompt, "Create");
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions.map((submission) => submission.key)).toEqual([
      submissions[0]!.expected,
      submissions[0]!.expected,
    ]);
    await startup.release();
    await creation.expectPromptVisible(prompt);
    const created = (await client.fetchWorkspaces()).entries.filter(
      (entry) => !before.has(entry.id),
    );
    expect(created).toHaveLength(1);
    expect(
      (await client.fetchAgents()).entries.filter(
        (entry) => entry.agent.workspaceId === created[0]!.id,
      ),
    ).toHaveLength(1);
  } finally {
    await startup.release();
    await client.close();
  }
});
