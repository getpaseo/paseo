import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import type { WorkflowRunDetails } from "@getpaseo/protocol/workflow/types";
import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { addConnectedHostAndReload, waitForConnectedHost } from "./helpers/hosts";
import { type IsolatedHostDaemon, startIsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import { connectSeedClient, seedWorkspace, type SeedDaemonClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";
import {
  buildFanoutWorkflow,
  buildSingleTurnWorkflow,
  buildTwoTurnWorkflow,
  goalDemoObjective,
  reviewedGoalDemoObjective,
  saveWorkflow,
  startWorkflow,
  waitForWorkflow,
} from "./helpers/workflows";
import { buildWorkflowsRoute } from "../src/utils/host-routes";

test.describe("Native workflows", () => {
  test.describe.configure({ timeout: 180_000 });

  test("imports JSON, validates, launches, monitors audit data, and opens the native agent", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "workflow-ui-" });
    const name = uniqueWorkflowName("ui");
    const spec = buildTwoTurnWorkflow({ name, delayMs: 1_500 });
    try {
      await page.goto(
        buildWorkflowsRoute({
          serverId: getServerId(),
          workspaceId: workspace.workspaceId,
        }),
      );
      await expect(page.getByText("Workflows", { exact: true }).last()).toBeVisible({
        timeout: 30_000,
      });

      await page.getByTestId("workflows-new-json").click();
      const editor = page.getByLabel("Workflow JSON");
      await editor.fill("{");
      await page.getByTestId("workflow-json-validate").click();
      await expect(page.getByTestId("workflows-action-error")).toContainText("JSON");

      await editor.fill(JSON.stringify(spec));
      await page.getByTestId("workflow-json-validate").click();
      await expect(page.getByTestId("workflows-action-success")).toContainText(
        "Workflow JSON is valid",
      );
      await page.getByTestId("workflow-json-save").click();
      await expect(page.getByTestId("workflows-action-success")).toContainText(`Saved ${name}`);

      await page.getByTestId(`workflow-spec-${name}`).click();
      await expect(page.getByTestId("workflow-launch-form")).toBeVisible();
      await expect(page.getByTestId("workflow-param-workspaceRef")).toContainText(
        "current.workspace",
      );
      await page.getByTestId("workflow-launch-submit").click();
      await expect(page.getByTestId("workflows-action-success")).toContainText("Queued wfr_");

      const runId = await findRunId(workspace.client, name);
      await expect(page.getByTestId(`workflow-run-${runId}`)).toBeVisible();
      await expect(page.getByTestId("workflow-run-details")).toContainText(/queued|running/);
      await captureEvidence(page, testInfo, "workflows-browser-running");

      const complete = await waitForWorkflow(workspace.client, runId, ["complete"]);
      expect(complete.state.result).toBe("ordered result");
      expect(acceptedEvents(complete)).toEqual(["next", "done"]);
      expect(complete.prompts).toHaveLength(2);

      await page.getByTestId("workflows-refresh").click();
      await page.getByTestId(`workflow-run-${runId}`).click();
      await expect(page.getByTestId("workflow-run-details")).toContainText("complete");
      await expect(page.getByTestId("workflow-run-details")).toContainText("event_accepted: done");
      await expect(page.getByText("Rendered prompts (2)", { exact: true })).toBeVisible();
      await captureEvidence(page, testInfo, "workflows-browser-complete");

      const agentId = complete.run.agentIds[0];
      expect(agentId).toBeTruthy();
      await page.getByRole("button", { name: agentId }).click();
      await expect(page).toHaveURL(/\/workspace\//);
      await expect(page).not.toHaveURL(/\/workflows/);
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      await workspace.cleanup();
    }
  });

  test("runs persistent goal, reviewed correction, and ordered bounded fan-out", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "workflow-demos-" });
    const nonce = Date.now().toString(36);
    try {
      const goalRunId = await startWorkflow(workspace.client, {
        workflowId: "goal",
        workspaceId: workspace.workspaceId,
        parameters: {
          workerProvider: "mock",
          workerModel: "ten-second-stream",
          workerMode: "load-test",
          workerThinking: "",
          objective: goalDemoObjective(),
          maxIterations: 4,
          maxRuntime: "5m",
        },
      });
      const goal = await waitForWorkflow(workspace.client, goalRunId, ["complete"]);
      expect(goal.run.iteration).toBe(2);
      expect(acceptedEvents(goal)).toEqual(["continue", "complete"]);
      expect(goal.run.agentIds).toHaveLength(1);

      const reviewedRunId = await startWorkflow(workspace.client, {
        workflowId: "reviewed-goal",
        workspaceId: workspace.workspaceId,
        parameters: {
          repoCwd: workspace.repoPath,
          prefix: `reviewed-${nonce}`,
          baseBranch: "main",
          workerProvider: "mock",
          workerModel: "ten-second-stream",
          workerMode: "load-test",
          workerThinking: "",
          reviewerProvider: "mock",
          reviewerModel: "ten-second-stream",
          reviewerMode: "load-test",
          reviewerThinking: "",
          objective: reviewedGoalDemoObjective(),
          reviewerDirective: "Require one explicit correction before accepting the final result.",
          maxRuntime: "5m",
        },
      });
      const reviewed = await waitForWorkflow(workspace.client, reviewedRunId, ["complete"], 60_000);
      expect(acceptedEvents(reviewed)).toEqual([
        "review",
        "continue",
        "review",
        "ready_to_finalize",
        "review",
        "revise",
        "review",
        "complete",
      ]);
      expect(reviewed.run.agentIds).toHaveLength(2);

      const fanoutName = uniqueWorkflowName("fanout");
      await saveWorkflow(workspace.client, buildFanoutWorkflow(fanoutName));
      const fanoutRunId = await startWorkflow(workspace.client, {
        workflowId: fanoutName,
        workspaceId: workspace.workspaceId,
      });
      const fanout = await waitForWorkflow(workspace.client, fanoutRunId, ["complete"], 60_000);
      expect(fanout.run.workspaceIds.length).toBeGreaterThanOrEqual(3);
      expect(fanout.run.agentIds).toHaveLength(3);
      expect(fanout.state.result).toEqual([
        expect.objectContaining({ index: 0, output: "first" }),
        expect.objectContaining({ index: 1, output: "second" }),
        expect.objectContaining({ index: 2, output: "third" }),
      ]);
      expect(fanout.events.find((event) => event.type === "map_started")?.details).toMatchObject({
        size: 3,
        concurrency: 2,
      });

      await page.goto(
        buildWorkflowsRoute({
          serverId: getServerId(),
          workspaceId: workspace.workspaceId,
        }),
      );
      for (const runId of [goalRunId, reviewedRunId, fanoutRunId]) {
        await expect(page.getByTestId(`workflow-run-${runId}`)).toContainText("complete", {
          timeout: 30_000,
        });
      }
      await page.getByTestId(`workflow-run-${fanoutRunId}`).click();
      await expect(page.getByTestId(`workflow-run-${fanoutRunId}`)).toContainText(
        /[3-9] workspaces/,
      );
      await captureEvidence(page, testInfo, "workflows-browser-required-demos");
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      await workspace.cleanup();
    }
  });

  test("gracefully stops without launching the next turn, then resumes it", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "workflow-stop-resume-" });
    const name = uniqueWorkflowName("stop-resume");
    try {
      await saveWorkflow(workspace.client, buildTwoTurnWorkflow({ name, delayMs: 8_000 }));
      await page.goto(
        buildWorkflowsRoute({
          serverId: getServerId(),
          workspaceId: workspace.workspaceId,
        }),
      );
      await expect(page.getByText("Workflows", { exact: true }).last()).toBeVisible({
        timeout: 30_000,
      });
      const runId = await startWorkflow(workspace.client, {
        workflowId: name,
        workspaceId: workspace.workspaceId,
      });
      await waitForWorkflow(workspace.client, runId, ["running"]);
      await page.getByTestId("workflows-refresh").click();
      await page.getByTestId(`workflow-run-${runId}`).click();
      await expect(page.getByTestId("workflow-run-stop")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workflow-run-stop").click();
      await expect(page.getByTestId("workflows-action-success")).toContainText("Stop requested");

      const stopped = await waitForWorkflow(workspace.client, runId, ["stopped"], 30_000);
      expect(stopped.run.iteration).toBe(1);
      expect(stopped.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stillStopped = await inspectRequired(workspace.client, runId);
      expect(stillStopped.run.status).toBe("stopped");
      expect(stillStopped.run.iteration).toBe(1);

      await page.getByTestId("workflows-refresh").click();
      await page.getByTestId(`workflow-run-${runId}`).click();
      await expect(page.getByTestId("workflow-run-resume")).toBeVisible();
      await captureEvidence(page, testInfo, "workflows-browser-stopped");
      await page.getByTestId("workflow-run-resume").click();
      await expect(page.getByTestId("workflows-action-success")).toContainText("Workflow resumed");

      const complete = await waitForWorkflow(workspace.client, runId, ["complete"], 30_000);
      expect(complete.run.iteration).toBe(2);
      expect(acceptedEvents(complete)).toEqual(["next", "done"]);
      await page.getByTestId("workflows-refresh").click();
      await page.getByTestId(`workflow-run-${runId}`).click();
      await expect(page.getByTestId("workflow-run-details")).toContainText("complete");
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      await workspace.cleanup();
    }
  });

  test("reconnects after isolated daemon restart and reconciles one native turn once", async ({
    page,
  }, testInfo) => {
    const serverId = `workflow-restart-${Date.now().toString(36)}`;
    const label = "Workflow Restart Host";
    let daemon: IsolatedHostDaemon | null = null;
    let client: SeedDaemonClient | null = null;
    const repo = await createTempGitRepo("workflow-restart-");
    let projectId: string | null = null;
    try {
      daemon = await startIsolatedHostDaemon(serverId);
      client = await connectSeedClient({ port: daemon.port });
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
        title: "Workflow restart fixture",
      });
      if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");
      const workspaceId = created.workspace.id;
      projectId = created.workspace.projectId;

      const name = uniqueWorkflowName("restart");
      await saveWorkflow(client, buildSingleTurnWorkflow({ name, delayMs: 4_000 }));
      const sockets = trackWebSockets(page, daemon.port);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId,
        label,
        port: daemon.port,
      });
      await waitForConnectedHost(page, {
        serverId,
        endpoint: `localhost:${daemon.port}`,
      });
      await page.getByTestId("sidebar-workflows").click();
      await page.getByTestId("workflows-host-filter").click();
      await page.getByText(label, { exact: true }).last().click();
      await expect(page.getByText("Workflows", { exact: true }).last()).toBeVisible({
        timeout: 30_000,
      });

      const runId = await startWorkflow(client, { workflowId: name, workspaceId });
      const active = await waitForActiveTurn(client, runId);
      expect(active.run.activeTurns).toBe(1);
      await page.getByTestId("workflows-refresh").click();
      await expect(page.getByTestId(`workflow-run-${runId}`)).toBeVisible({ timeout: 30_000 });

      await daemon.restart();
      await expect.poll(() => sockets.closes, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      await client.close().catch(() => undefined);
      client = await connectSeedClient({ port: daemon.port });

      const complete = await waitForWorkflow(client, runId, ["complete"], 30_000);
      expect(
        complete.run.iteration,
        JSON.stringify({ run: complete.run, events: complete.events }, null, 2),
      ).toBe(1);
      expect(acceptedEvents(complete)).toEqual(["done"]);
      const completedTurns = workflowCompletedTurns(complete);
      expect(completedTurns).toHaveLength(1);
      expect(new Set(completedTurns.map((turn) => turn.workflowTurnId)).size).toBe(1);
      const startedTurns = complete.events.filter((event) => event.type === "turn_started");
      expect(startedTurns).toHaveLength(1);
      expect(completedTurns[0]?.nativeTurnId).toBe(startedTurns[0]?.details?.nativeTurnId);

      const agentId = complete.run.agentIds[0];
      const timelineClient = client as SeedDaemonClient & WorkflowTimelineClient;
      const timeline = await timelineClient.fetchAgentTimeline(agentId, {
        direction: "tail",
        projection: "canonical",
        limit: 100,
      });
      const workflowMessages = timeline.entries
        .map((entry) => entry.item)
        .filter(
          (item): item is typeof item & { clientMessageId: string } =>
            item.type === "user_message" && typeof item.clientMessageId === "string",
        );
      expect(workflowMessages).toHaveLength(1);
      expect(new Set(workflowMessages.map((item) => item.clientMessageId)).size).toBe(1);

      await expect.poll(() => sockets.opens, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId(`workflow-run-${runId}`)).toContainText("complete", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("workflows-load-error")).toHaveCount(0);
      await captureEvidence(page, testInfo, "workflows-browser-reconnected");
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      if (client && projectId) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      await daemon?.close();
      await repo.cleanup();
    }
  });
});

function uniqueWorkflowName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function findRunId(client: SeedDaemonClient, workflowId: string): Promise<string> {
  await expect
    .poll(
      async () => {
        const payload = await client.workflowRunList();
        if (payload.error) throw new Error(payload.error);
        return payload.runs.find((run) => run.workflowId === workflowId)?.id ?? null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  const payload = await client.workflowRunList();
  const run = payload.runs.find((candidate) => candidate.workflowId === workflowId);
  if (!run) throw new Error(`Workflow run not found for ${workflowId}`);
  return run.id;
}

async function inspectRequired(
  client: SeedDaemonClient,
  runId: string,
): Promise<WorkflowRunDetails> {
  const payload = await client.workflowRunInspect(runId);
  if (payload.error || !payload.details) {
    throw new Error(payload.error ?? `Workflow run not found: ${runId}`);
  }
  return payload.details;
}

async function waitForActiveTurn(
  client: SeedDaemonClient,
  runId: string,
): Promise<WorkflowRunDetails> {
  await expect
    .poll(
      async () => {
        const details = await inspectRequired(client, runId);
        return details.run.activeTurns;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  return inspectRequired(client, runId);
}

function acceptedEvents(details: WorkflowRunDetails): string[] {
  return details.events.flatMap((event) =>
    event.type === "event_accepted" && event.event ? [event.event] : [],
  );
}

function workflowCompletedTurns(
  details: WorkflowRunDetails,
): Array<{ workflowTurnId: string; clientMessageId: string; nativeTurnId: string | null }> {
  const instances = (details.state.instances ?? {}) as Record<
    string,
    { agents?: Record<string, { turns?: Array<Record<string, unknown>> }> }
  >;
  return Object.values(instances).flatMap((instance) =>
    Object.values(instance.agents ?? {}).flatMap((agent) =>
      (agent.turns ?? []).flatMap((turn) =>
        typeof turn.workflowTurnId === "string" && typeof turn.clientMessageId === "string"
          ? [
              {
                workflowTurnId: turn.workflowTurnId,
                clientMessageId: turn.clientMessageId,
                nativeTurnId: typeof turn.nativeTurnId === "string" ? turn.nativeTurnId : null,
              },
            ]
          : [],
      ),
    ),
  );
}

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body: screenshot, contentType: "image/png" });
  const qaDirectory = process.env.PASEO_WORKFLOW_QA_DIR;
  if (!qaDirectory) return;
  await mkdir(qaDirectory, { recursive: true });
  await writeFile(path.join(qaDirectory, `${name}.png`), screenshot);
}

function trackWebSockets(page: Page, port: number): { opens: number; closes: number } {
  const counts = { opens: 0, closes: 0 };
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`:${port}`)) return;
    counts.opens += 1;
    socket.on("close", () => {
      counts.closes += 1;
    });
  });
  return counts;
}

interface WorkflowTimelineClient {
  fetchAgentTimeline(
    agentId: string,
    options: { direction: "tail"; projection: "canonical"; limit: number },
  ): Promise<{
    entries: Array<{
      item: {
        type: string;
        clientMessageId?: string;
        [key: string]: unknown;
      };
    }>;
  }>;
}
