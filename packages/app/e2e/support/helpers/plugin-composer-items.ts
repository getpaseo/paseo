import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";

const PLUGIN_ID = "composer-controls-example";
const NARROW = { width: 500, height: 800 };

/** Runs `run` in an agent's composer with the composer-controls example installed. */
export async function withComposerControlsExample(
  page: Page,
  run: (composer: {
    narrowTheWindow(): Promise<void>;
    openAgentFeatures(): Promise<void>;
    expectFeatureRow(name: string): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({
    repoPrefix: "composer-items-",
    title: "Composer items",
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Composer items agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("composer-controls");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await gotoAppShell(page);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await run({
      narrowTheWindow: () =>
        test.step("narrow the window until the composer folds its controls away", () =>
          page.setViewportSize(NARROW)),
      openAgentFeatures: () =>
        test.step("open the agent features sheet", async () => {
          await page.getByRole("button", { name: "Open agent features", exact: true }).click();
        }),
      expectFeatureRow: (name) =>
        test.step(`the sheet has a row for "${name}"`, () =>
          expect(page.getByRole("button", { name, exact: true })).toBeVisible()),
    });
  } finally {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
}

const ONE_TOGGLE_PLUGIN_ID = "composer-toggle-and-watcher-e2e";
const ONE_TOGGLE_NAME = "Sandbox flag";
const ONE_TOGGLE_PLUGIN_SOURCE = `import { useComposer } from "@getpaseo/plugin/client";
import { Toggle } from "@getpaseo/plugin/client/ui";
import { useState } from "react";

function PromptWatcher() {
  useComposer();
  return null;
}

function SandboxFlag() {
  const [value, setValue] = useState(false);
  return (
    <Toggle
      title="${ONE_TOGGLE_NAME}"
      icon="Lock"
      value={value}
      onValueChange={({ value: next }) => setValue(next)}
    />
  );
}

export default function contribute(client) {
  client.addComposerItem({ id: "prompt-watcher", Component: PromptWatcher });
  client.addComposerItem({ id: "sandbox-flag", Component: SandboxFlag });
  return () => {};
}`;

const PICKER_NAME = "Review state";
const PICKER_PLUGIN_SOURCE = `import { Select } from "@getpaseo/plugin/client/ui";
import { useState } from "react";

const OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
];

function ReviewState() {
  const [value, setValue] = useState("draft");
  return (
    <Select
      title="${PICKER_NAME}"
      icon="CircleDot"
      value={value}
      options={OPTIONS}
      onValueChange={({ value: next }) => setValue(next)}
    />
  );
}

export default function contribute(client) {
  client.addComposerItem({ id: "review-state", Component: ReviewState });
  return () => {};
}`;

function toolbar(page: Page) {
  return page.getByTestId("agent-controls-toolbar").filter({ visible: true }).first();
}

interface ToolbarFrame {
  overflowButton: boolean;
  clipped: boolean;
}

declare global {
  interface Window {
    __pluginToolbarFrames?: ToolbarFrame[];
  }
}

/** From the first frame on, records whether the toolbar condensed or clipped. Call before loading. */
export async function recordToolbarFramesFromLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: ToolbarFrame[] = [];
    window.__pluginToolbarFrames = frames;
    const tick = () => {
      const row = Array.from(
        document.querySelectorAll('[data-testid="agent-controls-toolbar"]'),
      ).find((node) => node.getClientRects().length > 0);
      if (row) {
        frames.push({
          overflowButton: row.querySelector('[data-testid="agent-controls-features"]') !== null,
          clipped: row.scrollWidth > row.clientWidth,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function expectToolbarNeverCondensedOrClipped(page: Page): Promise<void> {
  const frames = await page.evaluate(() => window.__pluginToolbarFrames ?? []);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.overflowButton || frame.clipped)).toEqual([]);
}

function agentFeaturesButton(page: Page) {
  return page.getByRole("button", { name: "Open agent features", exact: true });
}

interface ToolbarPluginComposer {
  setWindowWidth(width: number): Promise<void>;
  expectToolbarWidthBetween(min: number, max: number): Promise<void>;
  expectToggleInlineAtFullDensity(): Promise<void>;
  expectToggleInOverflow(): Promise<void>;
  closeOverflowSheet(): Promise<void>;
  startRecordingDensity(): Promise<void>;
  expectAtMostOneDensityChange(): Promise<void>;
  openInlinePicker(): Promise<void>;
  expectPickerClosed(): Promise<void>;
}

/** Runs `run` in an agent's composer with one icon toggle and one item that renders nothing. */
export function withToggleAndWatcherComposerItems(
  page: Page,
  run: (composer: ToolbarPluginComposer) => Promise<void>,
) {
  return withToolbarPlugin(page, ONE_TOGGLE_PLUGIN_SOURCE, run);
}

/** Runs `run` in an agent's composer with one plugin `Select` in the toolbar. */
export function withPickerComposerItem(
  page: Page,
  run: (composer: ToolbarPluginComposer) => Promise<void>,
) {
  return withToolbarPlugin(page, PICKER_PLUGIN_SOURCE, run);
}

async function withToolbarPlugin(
  page: Page,
  pluginSource: string,
  run: (composer: ToolbarPluginComposer) => Promise<void>,
) {
  const workspace = await seedWorkspace({ repoPrefix: "composer-measured-items-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Measured items agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-measured-items-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: ONE_TOGGLE_PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), pluginSource);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expect(toolbar(page)).toBeVisible({ timeout: 30_000 });
    await run({
      setWindowWidth: (width) =>
        test.step(`set the window to ${width} wide`, () =>
          page.setViewportSize({ width, height: 800 })),
      expectToolbarWidthBetween: (min, max) =>
        test.step(`the toolbar is between ${min} and ${max} wide`, async () => {
          await expect
            .poll(async () => (await toolbar(page).boundingBox())?.width ?? 0)
            .toBeGreaterThanOrEqual(min);
          expect((await toolbar(page).boundingBox())?.width ?? 0).toBeLessThanOrEqual(max);
        }),
      expectToggleInlineAtFullDensity: () =>
        test.step("the toggle is inline and the toolbar keeps its labels", async () => {
          const toggle = toolbar(page).getByRole("button", { name: ONE_TOGGLE_NAME, exact: true });
          await expect(toggle).toBeVisible();
          await expect(agentFeaturesButton(page)).toHaveCount(0);
          await expect(toolbar(page).getByTestId("agent-thinking-selector")).toHaveText("Low");
          const row = await toolbar(page).boundingBox();
          const box = await toggle.boundingBox();
          expect(box && row && box.x + box.width <= row.x + row.width).toBe(true);
        }),
      expectToggleInOverflow: () =>
        test.step("the toggle has moved to the overflow sheet", async () => {
          await expect(
            toolbar(page).getByRole("button", { name: ONE_TOGGLE_NAME, exact: true }),
          ).toHaveCount(0);
          await agentFeaturesButton(page).click();
          await expect(
            page.getByRole("button", { name: ONE_TOGGLE_NAME, exact: true }),
          ).toBeVisible();
        }),
      closeOverflowSheet: () =>
        test.step("close the overflow sheet", async () => {
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("agent-features-sheet")).toHaveCount(0);
        }),
      startRecordingDensity: () =>
        test.step("record which density each frame paints", () =>
          page.evaluate(() => {
            const frames: boolean[] = [];
            const paint = () => {
              frames.push(
                document.querySelector('[data-testid="agent-controls-features"]') !== null,
              );
              window.requestAnimationFrame(paint);
            };
            window.requestAnimationFrame(paint);
            Object.assign(window, { __densityFrames: frames });
          })),
      expectAtMostOneDensityChange: () =>
        test.step("the density changed once at most", async () => {
          const changes = await page.evaluate(() => {
            const frames = (window as unknown as { __densityFrames: boolean[] }).__densityFrames;
            return frames.filter((frame, index) => index > 0 && frame !== frames[index - 1]).length;
          });
          expect(changes).toBeLessThanOrEqual(1);
        }),
      openInlinePicker: () =>
        test.step("open the plugin picker from the toolbar", async () => {
          await toolbar(page).getByRole("button", { name: PICKER_NAME, exact: true }).click();
          await expect(page.getByTestId("combobox-desktop-container")).toBeVisible();
        }),
      expectPickerClosed: () =>
        test.step("the plugin picker has closed", () =>
          expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0)),
    });
  } finally {
    await client.removePlugin(ONE_TOGGLE_PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await workspace.cleanup();
  }
}
