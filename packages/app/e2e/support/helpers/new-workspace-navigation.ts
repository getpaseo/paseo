import { expect, test, type Page } from "../fixtures";
import { readFile } from "node:fs/promises";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { gotoAppShell } from "./app";
import { scrollTimelineToOldestLoadedEdge } from "./timeline-pagination";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  countWorkspaceAgents,
  countWorkspaceTerminals,
  delayBrowserWorkspaceCreatedResponse,
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  selectWorkspaceIsolation,
  submitNewWorkspaceEmpty,
  submitNewWorkspacePrompt,
  waitForCreatedWorkspace,
} from "./new-workspace";
import { createTempGitRepo } from "./workspace";
import { expectAppRoute } from "./route-assertions";
import { getServerId } from "./server-id";
import {
  expectTerminalOutputContains,
  expectWorkspaceOpensWithTerminalTab,
  fillTerminalPrompt,
  seedTerminalProfiles,
  selectLaunchOption,
  submitTerminalLaunch,
  type TerminalProfile,
} from "./new-workspace-launch";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";
import { dropFileOnComposer, expectAttachmentPill } from "./composer";

const PROMPT = "Hello from the navigation guard";
const NEXT_PROMPT = "Keep this newer draft";
const CONTEXT = {
  name: "context.json",
  mimeType: "application/json",
  buffer: Buffer.from('{"preserve":"attachment"}'),
};
const PROFILE: TerminalProfile = {
  id: "e2e-nav-guard-echo",
  name: "Nav Guard Echo",
  command: "/bin/sh",
  args: ["-c", 'echo captured: "$0"; sleep 120', "{{{prompt}}}"],
};

export async function verifyDelayedWorkspaceCreation(
  page: Page,
  launch: "chat" | "terminal" | "empty",
  destination: "leave" | "stay" | "new-draft",
  isolation: "local" | "worktree" = "local",
): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("workspace-focus-");
  const profileSeed = await seedTerminalProfiles([PROFILE]);
  const delay = await delayBrowserWorkspaceCreatedResponse(page);
  const serverId = getServerId();
  let localWorkspaceId: string | undefined;
  let createdDirectory: string | undefined;
  let newDraftRoute = "";

  try {
    const project = await openProjectViaDaemon(client, repo.path);
    localWorkspaceId = project.workspaceId;
    const knownIds = new Set((await client.fetchWorkspaces()).entries.map((entry) => entry.id));
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: project.workspaceId });

    await test.step("Submit workspace creation with the requested content", async () => {
      await openNewWorkspaceComposer(page, project);
      await selectWorkspaceIsolation(page, isolation);
      if (launch === "chat") {
        await dropFileOnComposer(page, CONTEXT);
        await expectAttachmentPill(page, "composer-file-attachment-pill");
        await submitNewWorkspacePrompt(page, PROMPT);
      } else if (launch === "terminal") {
        await selectLaunchOption(page, PROFILE.id);
        await fillTerminalPrompt(page, PROMPT);
        await submitTerminalLaunch(page);
      } else {
        await submitNewWorkspaceEmpty(page);
      }
      await delay.waitForCreateRequest();
    });

    await test.step("Choose where to work while the creation response is held", async () => {
      if (destination !== "stay") {
        await switchWorkspaceViaSidebar({ page, serverId, workspaceId: project.workspaceId });
      }
      if (destination === "new-draft") {
        await openNewWorkspaceComposer(page, project);
        await fillNewWorkspaceDraft(page, NEXT_PROMPT);
        const url = new URL(page.url());
        newDraftRoute = url.pathname + url.search;
      }
      // Recording pacing only; the response is held deterministically above.
      if (process.env.E2E_RECORD_VIDEO === "1") {
        await page.mouse.move(1100, 80);
        await page.waitForTimeout(1500);
      }
      delay.release();
    });

    const created = await waitForCreatedWorkspace(client, knownIds);
    createdDirectory = created.workspaceDirectory;
    expect(created.workspaceKind).toBe(isolation === "worktree" ? "worktree" : "local_checkout");
    await test.step("Completion creates exactly the requested resource and preserves focus", async () => {
      await expect
        .poll(() => countWorkspaceAgents(client, created.id))
        .toBe(launch === "chat" ? 1 : 0);
      await expect
        .poll(() => countWorkspaceTerminals(client, created.id))
        .toBe(launch === "terminal" ? 1 : 0);
      // A negative navigation assertion needs an observation window after completion.
      await page.waitForTimeout(5000);
      const expectedRoute =
        destination === "new-draft"
          ? newDraftRoute
          : buildHostWorkspaceRoute(
              serverId,
              destination === "stay" ? created.id : project.workspaceId,
            );
      await expectAppRoute(page, expectedRoute);
      if (destination === "new-draft") await expectNewWorkspaceDraft(page, NEXT_PROMPT);
      if (launch === "chat") {
        expect(delay.agentRequests).toHaveLength(1);
        const upload = delay.agentRequests[0]?.attachments?.find(
          (item) => item.type === "uploaded_file",
        );
        if (!upload) throw new Error("The create request did not contain the submitted file");
        expect(await readFile(upload.path)).toEqual(CONTEXT.buffer);
        expect(delay.agentRequests[0]).toMatchObject({
          workspaceId: created.id,
          initialPrompt: PROMPT,
          config: {
            provider: "mock",
            model: "ten-second-stream",
            modeId: "load-test",
            thinkingOptionId: "low",
            cwd: created.workspaceDirectory,
          },
          attachments: [
            expect.objectContaining({
              fileName: CONTEXT.name,
              mimeType: CONTEXT.mimeType,
              size: CONTEXT.buffer.length,
            }),
          ],
        });
      }
    });

    await test.step("Visit the new workspace and return without submitting a second draft", async () => {
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: created.id });
      if (launch === "chat") {
        await scrollTimelineToOldestLoadedEdge(page);
        await expect(page.getByText(PROMPT, { exact: true }).first()).toBeVisible();
      } else if (launch === "terminal") {
        await expectWorkspaceOpensWithTerminalTab(page);
        await expectTerminalOutputContains(page, `captured: ${PROMPT}`);
      }
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: project.workspaceId });
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: created.id });
      await expect
        .poll(() => countWorkspaceAgents(client, created.id))
        .toBe(launch === "chat" ? 1 : 0);
      await expect
        .poll(() => countWorkspaceTerminals(client, created.id))
        .toBe(launch === "terminal" ? 1 : 0);
      if (launch === "chat") {
        expect(delay.agentRequests).toHaveLength(1);
        await openNewWorkspaceComposer(page, project);
        await expectNewWorkspaceDraft(page, destination === "new-draft" ? NEXT_PROMPT : "");
      }
      if (process.env.E2E_RECORD_VIDEO === "1") {
        await page.mouse.move(1100, 80);
        await page.waitForTimeout(1500);
      }
    });
  } catch (error) {
    await page.screenshot({ path: test.info().outputPath("before-cleanup.png") });
    console.error(error);
    throw error;
  } finally {
    delay.release();
    if (createdDirectory) await archiveWorkspaceFromDaemon(client, createdDirectory);
    if (localWorkspaceId) await archiveLocalWorkspaceFromDaemon(client, localWorkspaceId);
    await profileSeed.restore();
    await client.close();
    await repo.cleanup();
  }
}
