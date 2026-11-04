import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { openCommandCenter } from "./command-center";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { createAgentTabFromMenu, ensureExplorerSidebar } from "./workspace-tabs";

const WIDE = { width: 1440, height: 900 };
const CHECKLIST = "- [ ] Tests\n- [ ] Docs\n";

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;

function prompt(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." });
}

async function createMockAgent(workspace: Workspace, title: string) {
  return workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
    model: "ten-second-stream",
    modeId: "load-test",
  });
}

async function runCommand(page: Page, title: string) {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

export async function withComposerToolsExample(
  page: Page,
  run: (author: {
    openComposerToolsInExplorer(): Promise<void>;
    typeInComposer(text: string, cursorAfter: number): Promise<void>;
    insertChecklistFromPanel(): Promise<void>;
    expectComposerText(text: string): Promise<void>;
    markForReviewFromCommandCenter(): Promise<void>;
    focusANewAgentTab(): Promise<void>;
    focusTheAgentTab(): Promise<void>;
    expectPanelFocusedAgent(focused: boolean): Promise<void>;
    expectPanelShowsReview(needsReview: boolean): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({ repoPrefix: "composer-tools-", title: "Composer tools" });
  const agent = await createMockAgent(workspace, "Composer tools agent");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("composer-controls");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await run({
      openComposerToolsInExplorer: () =>
        test.step("open the Composer tools panel in the Explorer", async () => {
          const explorer = await ensureExplorerSidebar(page);
          await explorer.getByRole("button", { name: "New tab", exact: true }).click();
          await page
            .getByTestId("workspace-new-tab-menu")
            .filter({ visible: true })
            .getByRole("menuitem", { name: "Composer tools", exact: true })
            .click();
          await expect(page.getByText("Focused agent: mock", { exact: true })).toBeVisible();
        }),
      typeInComposer: (text, cursorAfter) =>
        test.step(`type "${text}" and put the cursor after ${cursorAfter} characters`, async () => {
          const input = prompt(page);
          await input.fill(text);
          await input.press("Home");
          for (let index = 0; index < cursorAfter; index += 1) await input.press("ArrowRight");
        }),
      insertChecklistFromPanel: () =>
        test.step("press the panel's button", () =>
          page
            .getByRole("button", { name: "Insert checklist into the focused agent", exact: true })
            .click()),
      expectComposerText: (text) =>
        test.step("the composer holds the text", () => expect(prompt(page)).toHaveValue(text)),
      markForReviewFromCommandCenter: () =>
        test.step("run the Command Center item", () =>
          runCommand(page, "Composer controls: mark for review")),
      focusANewAgentTab: () =>
        test.step("focus a new agent tab, which is a draft", () => createAgentTabFromMenu(page)),
      focusTheAgentTab: () =>
        test.step("focus the running agent's tab again", () =>
          page
            .getByTestId(`workspace-tab-agent_${agent.id}`)
            .filter({ visible: true })
            .first()
            .click({ position: { x: 12, y: 13 } })),
      expectPanelFocusedAgent: (focused) =>
        test.step(`the panel ${focused ? "names" : "has no"} focused agent`, async () => {
          await expect(page.getByText("Focused agent: mock", { exact: true })).toHaveCount(
            focused ? 1 : 0,
          );
          await expect(page.getByText("No agent is focused", { exact: true })).toHaveCount(
            focused ? 0 : 1,
          );
        }),
      expectPanelShowsReview: (needsReview) =>
        test.step(`the panel's snapshot says needs review: ${needsReview}`, () =>
          expect(
            page.getByText(`Needs review: ${needsReview ? "yes" : "no"}`, { exact: true }),
          ).toBeVisible()),
    });
  } finally {
    await client.removePlugin("composer-controls-example");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
}

/**
 * A plugin that names an agent by id from a Command Center item while the user is in another
 * workspace: the target's workspace is not on screen, so its composer is not mounted.
 */
export async function withPluginWritingToAnotherWorkspace(
  page: Page,
  run: (author: {
    openTargetAgent(): Promise<void>;
    goToAnotherWorkspace(): Promise<void>;
    insertFromCommandCenter(): Promise<void>;
    returnToTargetWorkspace(): Promise<void>;
    expectComposerText(text: string): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({ repoPrefix: "composer-ref-", title: "Composer ref" });
  const elsewhere = await seedWorkspace({ repoPrefix: "composer-away-", title: "Composer away" });
  const target = await createMockAgent(workspace, "Target agent");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-ref-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "composer-ref", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `export default function contribute(client) {
  client.addCommandCenterItem({
    id: "note",
    title: "Composer ref: add a note",
    icon: "Flag",
    context: "global",
    onSelect({ composers }) {
      for (const composer of composers({ agentId: ${JSON.stringify(target.id)} })) composer.insertText("A note from a plugin");
    },
  });
  return () => {};
}`,
  );
  const targetTab = () => page.getByTestId(`workspace-tab-agent_${target.id}`);
  const workspaceRow = (id: string) =>
    page.getByTestId(`sidebar-workspace-row-${getServerId()}:${id}`);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await run({
      openTargetAgent: () =>
        test.step("open the agent the plugin will write to", async () => {
          await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: target.id });
          await expect(prompt(page)).toBeVisible({ timeout: 30_000 });
        }),
      goToAnotherWorkspace: () =>
        test.step("go to another workspace, so the agent's composer is not on screen", async () => {
          await workspaceRow(elsewhere.workspaceId).click();
          // The app keeps the workspace it left mounted, out of sight.
          await expect(targetTab().first()).toBeHidden();
        }),
      insertFromCommandCenter: () =>
        test.step("run the plugin's Command Center item", () =>
          runCommand(page, "Composer ref: add a note")),
      returnToTargetWorkspace: () =>
        test.step("return to the agent's workspace without reloading the app", async () => {
          await workspaceRow(workspace.workspaceId).click();
          await expect(targetTab().first()).toBeVisible({ timeout: 30_000 });
        }),
      expectComposerText: (text) =>
        test.step("its composer holds the text", () => expect(prompt(page)).toHaveValue(text)),
    });
  } finally {
    await client.removePlugin("composer-ref");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await elsewhere.cleanup();
    await workspace.cleanup();
  }
}

export { CHECKLIST };
