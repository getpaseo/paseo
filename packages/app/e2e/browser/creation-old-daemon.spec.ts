/* eslint-disable no-empty-pattern -- Playwright reads fixture dependencies from destructured parameters. */
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { metroTest, expect } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { withProjectOwnership } from "../support/helpers/project-ownership";
import { createTempGitRepo } from "../support/helpers/workspace";
import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { buildSeededHost, buildCreateAgentPreferences } from "../support/helpers/daemon-registry";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
  loadSessionMessageReaders,
} from "../support/helpers/new-workspace";
import { fillComposerDraft } from "../support/helpers/composer";
import { pressSubmitBeforeTheNextRender } from "../support/helpers/creation";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";

for (const version of ["0.2.5", "0.7.2", "0.8.0"]) {
  let daemon: Awaited<ReturnType<typeof startIsolatedHostDaemon>>;
  const test = metroTest.extend<{
    client: DaemonClient;
    gate: Awaited<ReturnType<typeof holdLegacyAgentCreation>>;
    repo: Awaited<ReturnType<typeof createTempGitRepo>>;
    project: Awaited<ReturnType<typeof seedWorkspace>>;
  }>({
    gate: async ({ page }, provide) => {
      const gate = await holdLegacyAgentCreation(page, daemon.port);
      await provide(gate);
      gate.release();
    },
    client: async ({}, provide) => {
      const client = withProjectOwnership(
        await connectDaemonClient<DaemonClient>({
          clientIdPrefix: "legacy-creation",
          port: daemon.port,
        }),
      );
      await provide(client);
      await client.close();
    },
    repo: async ({}, provide) => {
      const repo = await createTempGitRepo("legacy-creation-");
      await provide(repo);
      await repo.cleanup();
    },
    project: async ({}, provide) => {
      const project = await seedWorkspace({ repoPrefix: "legacy-app-", port: daemon.port });
      await provide(project);
      await project.cleanup();
    },
  });
  test.describe(`published daemon ${version}`, () => {
    test.beforeAll(async () => {
      test.setTimeout(120_000);
      daemon = await startIsolatedHostDaemon(`srv_creation_${randomUUID()}`, {
        publishedVersion: version,
      });
    });
    test.afterAll(async () => {
      await daemon?.close();
    });

    for (const kind of ["workspace", "agent"] as const) {
      test(`current client creates a keyed ${kind} and initial prompt on a published old daemon`, async ({
        repo,
        client,
      }) => {
        const prompt = `Create ${kind}: emit 1 coalesced agent stream updates`;
        const features = client.getLastServerInfoMessage()?.features;
        expect(features?.creationLifecycle).not.toBe(true);
        expect(features?.workspaceRequestReceipts).not.toBe(true);
        expect(features?.agentRequestReceipts === true).toBe(version === "0.8.0");

        const create = await prepareCreation(client, kind, repo.path, prompt);
        const [agent, duplicate] = await Promise.all([create(), create()]);
        expect(duplicate.id).toBe(agent.id);
        expect(agent.title).toBe(prompt);
        await client.waitForFinish(agent.id, 20_000);
        const agents = await client.fetchAgents();
        expect(agents.entries).toHaveLength(1);
        expect(agents.entries[0]!.agent.title).toBe(prompt);
        const timeline = await client.fetchAgentTimeline(agent.id);
        expect(
          timeline.entries.filter(
            ({ item }) => item.type === "user_message" && item.text === prompt,
          ),
        ).toHaveLength(1);
      });
    }

    test("current app creates a workspace, navigates before agent startup, and creates another agent on an old daemon", async ({
      page,
      project,
      client,
      gate,
    }) => {
      await openOldHost(page, project.workspaceId);
      await openNewWorkspaceComposer(page, project);
      await selectWorkspaceIsolation(page, "worktree");
      const prompt = "Create this workspace: emit 1 coalesced agent stream updates";
      await fillComposerDraft(page, prompt);
      await pressSubmitBeforeTheNextRender(page, "Create");
      await gate.waitForRequest();
      await expect(page).toHaveURL(/\/workspace\//);
      await expect(
        page.getByTestId("user-message").filter({ visible: true }).filter({ hasText: prompt }),
      ).toBeVisible();
      expect((await client.fetchAgents()).entries).toHaveLength(0);
      const workspaces = (await client.fetchWorkspaces()).entries.filter(
        (workspace) =>
          workspace.projectId === project.projectId && workspace.id !== project.workspaceId,
      );
      expect(workspaces).toHaveLength(1);
      gate.release();
      await expect.poll(async () => (await client.fetchAgents()).entries.length).toBe(1);
      const first = (await client.fetchAgents()).entries[0]!.agent;
      await client.waitForFinish(first.id, 20_000);
      await expectPromptOnce(client, first.id, prompt);
      await expect(
        page.getByTestId(`workspace-tab-agent_${first.id}`).filter({ visible: true }),
      ).toHaveText(prompt);

      await createAgentTabFromMenu(page);
      const secondPrompt = "Create another agent: emit 1 coalesced agent stream updates";
      await fillComposerDraft(page, secondPrompt);
      await pressSubmitBeforeTheNextRender(page, "Send message");
      await expect.poll(async () => (await client.fetchAgents()).entries.length).toBe(2);
      const second = (await client.fetchAgents()).entries.find(
        ({ agent }) => agent.id !== first.id,
      )!.agent;
      expect(second.workspaceId).toBe(first.workspaceId);
      await client.waitForFinish(second.id, 20_000);
      await expectPromptOnce(client, second.id, secondPrompt);
      await expect(
        page.getByTestId(`workspace-tab-agent_${second.id}`).filter({ visible: true }),
      ).toHaveText(secondPrompt);
      await expect(
        page
          .getByTestId("user-message")
          .filter({ visible: true })
          .filter({ hasText: secondPrompt }),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("old-daemon-creation.png") });
    });

    async function expectPromptOnce(client: DaemonClient, agentId: string, text: string) {
      const timeline = await client.fetchAgentTimeline(agentId);
      expect(
        timeline.entries.filter(({ item }) => item.type === "user_message" && item.text === text),
      ).toHaveLength(1);
    }

    async function openOldHost(page: Page, workspaceId: string) {
      const host = buildSeededHost({
        serverId: daemon.serverId,
        endpoint: `127.0.0.1:${daemon.port}`,
        nowIso: new Date().toISOString(),
      });
      await page.addInitScript(
        ({ seededHost, preferences }) => {
          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
          localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
        },
        { seededHost: host, preferences: buildCreateAgentPreferences() },
      );
      await page.goto(buildHostWorkspaceRoute(daemon.serverId, workspaceId));
    }

    async function prepareCreation(
      client: DaemonClient,
      kind: "workspace" | "agent",
      cwd: string,
      prompt: string,
    ) {
      const input = { provider: "mock", cwd, initialPrompt: prompt };
      if (kind === "workspace")
        return async () => {
          const result = await client.createWorkspace({
            idempotencyKey: "workspace-intent",
            source: { kind: "worktree", cwd, worktreeSlug: "created-once" },
            agent: input,
          });
          expect(result.error).toBeNull();
          expect(result.workspace?.workspaceDirectory).not.toBe(cwd);
          return result.agent!;
        };
      const workspace = await client.createWorkspace({
        idempotencyKey: "empty-workspace",
        source: { kind: "directory", path: cwd },
      });
      return () =>
        client.createAgent({
          ...input,
          workspaceId: workspace.workspace!.id,
          idempotencyKey: "agent-intent",
        });
    }
  });
}

async function holdLegacyAgentCreation(page: Page, port: number) {
  const readers = await loadSessionMessageReaders();
  const arrived = Promise.withResolvers<void>();
  let release = () => {};
  let holding = true;
  await page.routeWebSocket(new RegExp(`:${port}/ws`), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      if (holding && readers.client(frame)?.type === "create_agent_request") {
        holding = false;
        release = () => server.send(frame);
        arrived.resolve();
      } else server.send(frame);
    });
    server.onMessage((frame) => browser.send(frame));
  });
  return {
    waitForRequest: () => arrived.promise,
    release() {
      const send = release;
      release = () => {};
      send();
    },
  };
}
