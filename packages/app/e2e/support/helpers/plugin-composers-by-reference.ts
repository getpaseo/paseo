import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { attachComposerTestImage, openImageLightbox } from "./composer";
import {
  contextWindowDetails,
  pressContextWindowMeter,
  seedAgentWithContextWindow,
} from "./context-window";
import { gotoWorkspace } from "./launcher";
import { openCommandCenter } from "./command-center";
import { openAgentRoute, seedMockAgentWorkspace } from "./mock-agent";
import { connectNewWorkspaceDaemonClient, openGlobalNewWorkspaceComposer } from "./new-workspace";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import {
  expectNoSheetOpen,
  expectOpenTabCount,
  promptMentioning,
  sheet,
  tapSheetBackdrop,
} from "./sheet";
import { openSubagentFromCompactTrack, seedSubagent } from "./subagents";
import { getServerId } from "./server-id";
import {
  createAgentTabFromMenu,
  dragTabIntoExplorer,
  ensureExplorerSidebar,
} from "./workspace-tabs";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };
const CHECKLIST = "- [ ] Tests\n- [ ] Docs\n";
const FILE_LINK = "linked.ts:3";

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
    useCompactLayout(): Promise<void>;
    insertChecklistFromControlsSheet(): Promise<void>;
    expectComposerReadyToType(text: string): Promise<void>;
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
      useCompactLayout: () =>
        test.step("narrow the window to a phone", async () => {
          await page.setViewportSize(COMPACT);
          await expect(prompt(page).filter({ visible: true })).toBeVisible();
        }),
      insertChecklistFromControlsSheet: () =>
        test.step("press the Action in the composer's controls sheet", async () => {
          await page.getByRole("button", { name: /^Select model/ }).click();
          await page.getByText("Insert checklist", { exact: true }).click();
        }),
      expectComposerReadyToType: (text) =>
        test.step("the sheet is closed and the cursor is in the composer", async () => {
          await expectNoSheetOpen(page);
          const input = prompt(page).filter({ visible: true });
          await expect(input).toHaveValue(text);
          await expect(input).toBeFocused();
        }),
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

/**
 * A plugin that reaches one agent's composer from a pill and from Command Center items, and asks
 * for focus, wherever the user is.
 */
export async function withPluginFocusingAComposer(
  page: Page,
  run: (author: {
    openOtherAgent(): Promise<void>;
    openTargetAgent(): Promise<void>;
    goToAnotherWorkspace(): Promise<void>;
    moveFocusOutOfComposer(): Promise<void>;
    pressPill(): Promise<void>;
    focusFromCommandCenter(): Promise<void>;
    selectPromptFromCommandCenter(): Promise<void>;
    useCompactLayout(): Promise<void>;
    coverComposerWithExplorerPanel(): Promise<void>;
    pressPanelFocusButton(): Promise<void>;
    expectExplorerPanelClosed(): Promise<void>;
    fillComposer(text: string): Promise<void>;
    expectOnTargetAgent(): Promise<void>;
    expectComposerFocused(): Promise<void>;
    typeAtCursor(text: string): Promise<void>;
    expectComposerText(text: string): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({ repoPrefix: "composer-focus-", title: "Composer focus" });
  const elsewhere = await seedWorkspace({ repoPrefix: "focus-away-", title: "Focus away" });
  const target = await createMockAgent(workspace, "Target agent");
  const other = await createMockAgent(workspace, "Other agent");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-focus-"));
  const targetId = JSON.stringify(target.id);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "composer-focus", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import { Pressable, Text } from "react-native";

export default function contribute(client) {
  client.addComposerPill({
    id: "hello",
    workspaceId: ${JSON.stringify(workspace.workspaceId)},
    agentId: ${targetId},
    button: {
      title: "Add HELLO to the composer",
      icon: "Hand",
      label: "Hello",
      behavior: {
        kind: "action",
        async onPress() {
          for (const composer of client.composers({ agentId: ${targetId} })) {
            composer.insertText("HELLO");
            await composer.focus();
          }
        },
      },
    },
  });
  client.addWorkspacePanel({
    id: "tools",
    title: "Focus tools",
    icon: "ListChecks",
    locations: ["explorer"],
    Component() {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Focus the target agent"
          onPress={() => client.composers({ agentId: ${targetId} })[0]?.focus()}
        >
          <Text>Focus the target agent</Text>
        </Pressable>
      );
    },
  });
  client.addCommandCenterItem({
    id: "focus",
    title: "Composer focus: focus the target",
    icon: "Flag",
    context: "global",
    onSelect({ composers }) {
      return composers({ agentId: ${targetId} })[0].focus();
    },
  });
  client.addCommandCenterItem({
    id: "select",
    title: "Composer focus: select the prompt",
    icon: "Flag",
    context: "global",
    onSelect({ composers }) {
      const composer = composers({ agentId: ${targetId} })[0];
      return composer.focus({ selection: { start: 0, end: composer.prompt.length } });
    },
  });
  return () => {};
}`,
  );
  const targetTab = () => page.getByTestId(`workspace-tab-agent_${target.id}`);
  const workspaceRow = (id: string) =>
    page.getByTestId(`sidebar-workspace-row-${getServerId()}:${id}`);
  const panelFocusButton = () =>
    page.getByRole("button", { name: "Focus the target agent", exact: true });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await run({
      openOtherAgent: () =>
        test.step("open another agent, so the target's tab is not showing", async () => {
          await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: other.id });
          await expect(prompt(page)).toBeVisible({ timeout: 30_000 });
        }),
      openTargetAgent: () =>
        test.step("open the target agent", async () => {
          await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: target.id });
          await expect(prompt(page)).toBeVisible({ timeout: 30_000 });
        }),
      goToAnotherWorkspace: () =>
        test.step("go to another workspace", async () => {
          await workspaceRow(elsewhere.workspaceId).click();
          await expect(targetTab().first()).toBeHidden();
        }),
      moveFocusOutOfComposer: () =>
        test.step("the composer does not have focus", async () => {
          await prompt(page).blur();
          await expect(prompt(page)).not.toBeFocused();
        }),
      pressPill: () =>
        test.step("press the pill", () => page.getByRole("button", { name: "Hello" }).click()),
      focusFromCommandCenter: () =>
        test.step("run the plugin's focus command", () =>
          runCommand(page, "Composer focus: focus the target")),
      selectPromptFromCommandCenter: () =>
        test.step("run the plugin's select command", () =>
          runCommand(page, "Composer focus: select the prompt")),
      useCompactLayout: () =>
        test.step("use a phone-sized window", () => page.setViewportSize(COMPACT)),
      coverComposerWithExplorerPanel: () =>
        test.step("open the plugin's panel in the Explorer, covering the composer", async () => {
          const explorer = await ensureExplorerSidebar(page);
          await explorer.getByRole("button", { name: "New tab", exact: true }).click();
          await page
            .getByTestId("workspace-new-tab-menu")
            .filter({ visible: true })
            .getByRole("menuitem", { name: "Focus tools", exact: true })
            .click();
          await expect(panelFocusButton()).toBeVisible();
        }),
      pressPanelFocusButton: () =>
        test.step("press the panel's button", () => panelFocusButton().click()),
      expectExplorerPanelClosed: () =>
        test.step("the Explorer no longer covers the composer", () =>
          expect(panelFocusButton()).toBeHidden({ timeout: 30_000 })),
      fillComposer: (text) =>
        test.step(`write "${text}" in the composer`, () => prompt(page).fill(text)),
      expectOnTargetAgent: () =>
        test.step("the target agent's tab is showing", async () => {
          await expect(targetTab().filter({ visible: true }).first()).toHaveAttribute(
            "aria-selected",
            "true",
            { timeout: 30_000 },
          );
        }),
      expectComposerFocused: () =>
        test.step("the composer input has focus", () =>
          expect(prompt(page)).toBeFocused({ timeout: 30_000 })),
      typeAtCursor: (text) => test.step(`type "${text}"`, () => page.keyboard.type(text)),
      expectComposerText: (text) =>
        test.step("the composer holds the text", () => expect(prompt(page)).toHaveValue(text)),
    });
  } finally {
    await client.removePlugin("composer-focus");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await elsewhere.cleanup();
    await workspace.cleanup();
  }
}

export { CHECKLIST };

type HeldComposerGlobal = typeof globalThis & {
  heldComposer?: {
    focus(options?: { selection?: { start: number; end: number } }): Promise<void>;
  };
};

export async function withPluginHoldingNewWorkspaceComposer(
  page: Page,
  run: (author: {
    openNewWorkspace(): Promise<void>;
    leaveCompactExplorerForNewWorkspace(): Promise<void>;
    openSettings(): Promise<void>;
    openThinkingPicker(): Promise<void>;
    previewAttachedImage(): Promise<void>;
    typeInHeldComposer(text: string): Promise<void>;
    expectOverlappingFocusesKeepTheLatestSelection(): Promise<void>;
    expectHeldComposerFocusResult(result: string): Promise<void>;
    expectHeldComposerReadyToType(): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({ repoPrefix: "held-composer-", title: "Held composer" });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-held-composer-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "held-composer", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import { useComposer } from "@getpaseo/plugin/client";

function Holder() {
  globalThis.heldComposer = useComposer();
  return null;
}

export default function contribute(client) {
  client.addComposerItem({ id: "holder", Component: Holder });
  return () => {};
}`,
  );
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await run({
      openNewWorkspace: () =>
        test.step("open the New workspace composer", async () => {
          await openGlobalNewWorkspaceComposer(page);
          await page.waitForFunction(() => (globalThis as HeldComposerGlobal).heldComposer);
        }),
      leaveCompactExplorerForNewWorkspace: () =>
        test.step("leave a compact Explorer for New workspace with the shortcut", async () => {
          await gotoWorkspace(page, workspace.workspaceId);
          await page.setViewportSize(COMPACT);
          await expect(await ensureExplorerSidebar(page)).toBeVisible();
          await page.evaluate(() => {
            (globalThis as HeldComposerGlobal).heldComposer = undefined;
          });
          await page.keyboard.press("ControlOrMeta+n");
          await expect(page).toHaveURL(/\/new(?:\?.*)?$/);
          // A compact composer mounts plugin items inside its controls sheet.
          await page.getByRole("button", { name: /^Select model/ }).click();
          await page.waitForFunction(() => (globalThis as HeldComposerGlobal).heldComposer);
          await tapSheetBackdrop(page);
          await expectNoSheetOpen(page);
        }),
      openSettings: () =>
        test.step("push Settings over the New workspace screen", async () => {
          await page.getByTestId("sidebar-settings").filter({ visible: true }).click();
          await expect(page.getByTestId("settings-sidebar")).toBeVisible();
        }),
      openThinkingPicker: () =>
        test.step("open the thinking picker in the New workspace composer", async () => {
          await page
            .getByRole("button", { name: /^Select thinking option/ })
            .filter({ visible: true })
            .click();
          await expect(page.getByText("High", { exact: true })).toBeVisible();
        }),
      previewAttachedImage: () =>
        test.step("attach an image to the New workspace composer and preview it", async () => {
          await attachComposerTestImage(page);
          await openImageLightbox(page);
        }),
      typeInHeldComposer: (text) =>
        test.step(`type ${text} in the New workspace composer`, async () => {
          await prompt(page).filter({ visible: true }).fill(text);
        }),
      expectOverlappingFocusesKeepTheLatestSelection: () =>
        test.step("two overlapping focus() calls leave the later selection", async () => {
          const selection = await page.evaluate(async () => {
            const composer = (globalThis as HeldComposerGlobal).heldComposer!;
            await Promise.all([
              composer.focus({ selection: { start: 0, end: 1 } }),
              composer.focus({ selection: { start: 2, end: 4 } }),
            ]);
            const input = document.activeElement as HTMLTextAreaElement;
            return [input.selectionStart, input.selectionEnd];
          });
          expect(selection).toEqual([2, 4]);
        }),
      expectHeldComposerReadyToType: () =>
        test.step("nothing covers the composer and the cursor is in it", async () => {
          await expect(page.getByText("High", { exact: true })).toHaveCount(0);
          await expect(page.getByTestId("attachment-lightbox-close")).toHaveCount(0);
          await expect(prompt(page).filter({ visible: true })).toBeFocused();
        }),
      expectHeldComposerFocusResult: (result) =>
        test.step(`the held composer's focus() reports ${result}`, async () => {
          const actual = await page.evaluate(() =>
            (globalThis as HeldComposerGlobal).heldComposer?.focus().then(
              () => "focused",
              (error: Error) => error.message,
            ),
          );
          expect(actual).toBe(result);
        }),
    });
  } finally {
    await client.removePlugin("held-composer");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await workspace.cleanup();
  }
}

type FocusAgentGlobal = typeof globalThis & {
  focusAgent?: (agentId: string) => Promise<void>;
};

export async function withPluginFocusingASubagent(
  page: Page,
  run: (author: {
    openParentAgent(): Promise<void>;
    openExplorer(): Promise<void>;
    focusSubagent(): Promise<void>;
    expectSubagentTabReadyToType(): Promise<void>;
    keepParentInExplorerOnCompactScreen(): Promise<void>;
    focusParent(): Promise<void>;
    expectParentReadyToType(): Promise<void>;
    coverExplorerComposerWithFileSheet(): Promise<void>;
    focusParentAsAFileSheetOpens(): Promise<void>;
    openSubagentPageInParentComposer(): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "focus-subagent-",
    title: "Focus parent",
    initialPrompt: promptMentioning(FILE_LINK),
  });
  await writeFile(path.join(workspace.cwd, "linked.ts"), "one\ntwo\nthree\n", "utf8");
  const child = await seedSubagent(
    { client: workspace.client, repoPath: workspace.cwd, workspaceId: workspace.workspaceId },
    { parentId: workspace.agentId, title: "Focus child" },
  );
  const plugin = await installFocusingPlugin(page);
  const { focusAgent } = plugin;
  try {
    await page.setViewportSize(COMPACT);
    await gotoAppShell(page);
    await run({
      keepParentInExplorerOnCompactScreen: () =>
        test.step("move the parent into the Explorer, then narrow the window", async () => {
          await page.setViewportSize(WIDE);
          await openAgentRoute(page, {
            workspaceId: workspace.workspaceId,
            agentId: workspace.agentId,
          });
          await page.waitForFunction(() => (globalThis as FocusAgentGlobal).focusAgent);
          // The seeded turn must finish first, so the drag isn't racing its updates to the tab.
          await expect(page.getByText(FILE_LINK, { exact: true })).toBeVisible({ timeout: 15_000 });
          const explorer = await ensureExplorerSidebar(page);
          await dragTabIntoExplorer(page, `agent_${workspace.agentId}`);
          await expect(
            explorer.getByTestId(`workspace-tab-agent_${workspace.agentId}`),
          ).toBeVisible();
          await page.setViewportSize(COMPACT);
          // The phone layout hides the Explorer; focus must find it there, not in the wide layout.
          await expect(explorer).toBeHidden();
        }),
      focusParent: () =>
        test.step("focus the agent kept in the Explorer", () => focusAgent(workspace.agentId)),
      expectParentReadyToType: () =>
        test.step("no sheet is open and the cursor is in the composer", async () => {
          await expectNoSheetOpen(page);
          await expect(prompt(page).filter({ visible: true })).toBeFocused();
        }),
      openSubagentPageInParentComposer: () =>
        test.step("open the subagent's page from the parent's Subagents track", async () => {
          await openSubagentFromCompactTrack(page, child.id);
          await expect(sheet(page, child.title)).toBeVisible();
        }),
      coverExplorerComposerWithFileSheet: () =>
        test.step("open a file's sheet over the Explorer's composer", async () => {
          await page.getByText(FILE_LINK, { exact: true }).filter({ visible: true }).click();
          await expect(sheet(page, "linked.ts")).toBeVisible();
        }),
      focusParentAsAFileSheetOpens: () =>
        test.step("focus the agent while a file's sheet is opening over it", async () => {
          // The click looks the file up first. Focus in the commit that mounts the sheet, before
          // its opening animation has started.
          await page.evaluate((id) => {
            const global = globalThis as FocusAgentGlobal & {
              focusedAsSheetOpens?: Promise<string>;
            };
            global.focusedAsSheetOpens = new Promise((resolve) => {
              const observer = new MutationObserver(() => {
                if (!document.querySelector('[aria-label="Bottom sheet backdrop"]')) return;
                observer.disconnect();
                void global.focusAgent?.(id).then(
                  () => resolve("focused"),
                  (error: Error) => resolve(error.message),
                );
              });
              observer.observe(document.body, { childList: true, subtree: true });
            });
          }, workspace.agentId);
          await page.getByText(FILE_LINK, { exact: true }).filter({ visible: true }).click();
          const outcome = await page.evaluate(
            () => (globalThis as { focusedAsSheetOpens?: Promise<string> }).focusedAsSheetOpens,
          );
          expect(outcome).toBe("focused");
        }),
      openParentAgent: () =>
        test.step("open the parent agent on a phone", async () => {
          await openAgentRoute(page, {
            workspaceId: workspace.workspaceId,
            agentId: workspace.agentId,
          });
          await expect(prompt(page)).toBeVisible({ timeout: 30_000 });
          await expectOpenTabCount(page, 1);
          await page.waitForFunction(() => (globalThis as FocusAgentGlobal).focusAgent);
        }),
      openExplorer: () =>
        test.step("open the Explorer over the parent's composer", async () => {
          await expect(await ensureExplorerSidebar(page)).toBeVisible();
        }),
      focusSubagent: () =>
        test.step("focus the subagent, which has no tab", () => focusAgent(child.id)),
      expectSubagentTabReadyToType: () =>
        test.step("the subagent is a tab with the cursor in its composer", async () => {
          await expectNoSheetOpen(page);
          await expectOpenTabCount(page, 2);
          await expect(prompt(page)).toBeFocused();
        }),
    });
  } finally {
    await plugin.remove();
    await workspace.cleanup();
  }
}

/** A plugin that focuses any agent's composer, as a callback holding the agent's id would. */
async function installFocusingPlugin(page: Page) {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-focus-agent-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "focus-agent", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `export default function contribute(client) {
  globalThis.focusAgent = (agentId) => client.composers({ agentId })[0].focus();
  return () => {};
}`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return {
    focusAgent: async (agentId: string) => {
      const result = await page.evaluate(
        (id) =>
          (globalThis as FocusAgentGlobal).focusAgent?.(id).then(
            () => "focused",
            (error: Error) => error.message,
          ),
        agentId,
      );
      expect(result).toBe("focused");
    },
    remove: async () => {
      await client.removePlugin("focus-agent");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function withPluginFocusingAnAgentWithContextUsage(
  page: Page,
  run: (author: {
    openContextUsageOnPhone(): Promise<void>;
    focusAgent(): Promise<void>;
    expectReadyToType(): Promise<void>;
  }) => Promise<void>,
) {
  const agent = await seedAgentWithContextWindow();
  const plugin = await installFocusingPlugin(page);
  try {
    await page.setViewportSize(COMPACT);
    await gotoAppShell(page);
    await run({
      openContextUsageOnPhone: () =>
        test.step("open the agent's context usage on a phone", async () => {
          await openAgentRoute(page, agent);
          await page.waitForFunction(() => (globalThis as FocusAgentGlobal).focusAgent);
          await pressContextWindowMeter(page);
        }),
      focusAgent: () => test.step("focus the agent", () => plugin.focusAgent(agent.agentId)),
      expectReadyToType: () =>
        test.step("the context usage is closed and the cursor is in the composer", async () => {
          await expect(contextWindowDetails(page)).toHaveCount(0);
          await expect(prompt(page).filter({ visible: true })).toBeFocused();
        }),
    });
  } finally {
    await plugin.remove();
    await agent.cleanup();
  }
}
