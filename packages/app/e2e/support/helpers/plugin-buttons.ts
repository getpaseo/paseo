import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { test, expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { buildAgentRoute } from "./mock-agent";
import { openCommandCenter } from "./command-center";
import {
  closeCompactWorkspaceMenu,
  compactWorkspaceMenu,
  goBackInMenu,
  openCompactWorkspaceMenu,
} from "./compact-workspace-scripts";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import { pluginRequirements } from "./plugin-fixture";

const PLUGIN_ID = "button-showcase";
const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

function clientSource(workspaceId: string, agentId: string): string {
  return `import React from "react";
import { Text, View, Pressable } from "react-native";
import { useWorkspace, useRpc, usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { summary } from "./shared/rpc";

function StatusIcon({ size, theme }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.statusSuccess }} />;
}

function Details({ workspaceId, theme, layout, close }) {
  const workspace = useWorkspace(workspaceId, (workspace) => workspace.name);
  const paseo = usePaseo();
  const [ownerId, setOwnerId] = React.useState("");
  const [updates, setUpdates] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const owner = paseo.observeEvents(["project.update"]);
    owner.subscribe({ snapshot(value) { setOwnerId(value.subscriptionId); }, update() { setUpdates((n) => n + 1); } });
    return () => { void owner.release(); };
  }, [paseo]);
  const rpc = useRpc(summary);
  const query = useQuery({ queryKey: ["summary"], queryFn: () => rpc({}) });
  if (failed) throw new Error("Button content failed");
  return <View style={{ gap: 12 }}>
    <Text accessibilityLabel="Content observation" style={{ color: theme.colors.foreground }}>{ownerId}</Text>
    <Text style={{ color: theme.colors.foreground }}>Observed updates: {updates}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Fail button content" onPress={() => setFailed(true)}><Text style={{ color: theme.colors.foreground }}>Fail content</Text></Pressable>
    <Text style={{ color: theme.colors.foreground, fontSize: 18 }}>Deployment status</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>{workspace}</Text>
    <Text style={{ color: theme.colors.statusSuccess }}>{query.data?.message ?? "Loading deployment..."}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>3 checks passed · Production</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>Presentation: {layout.compact ? "compact" : "wide"}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Close deployment details" onPress={close} style={{ padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}><Text style={{ color: theme.colors.foreground }}>Done</Text></Pressable>
  </View>;
}

export default function contribute(client) {
  const workspaceId = ${JSON.stringify(workspaceId)};
  const agentId = ${JSON.stringify(agentId)};
  const registrations = [];
  let finish = () => {};
  let finishReview = () => {};
  let attempts = 0;
  const action = { kind: "action", async onPress() {
    if (++attempts % 2 === 1) throw new Error("Deployment failed. Try again.");
    await new Promise((resolve) => { finish = resolve; });
    deploy.update({ label: "Deployed" });
  } };
  const header = (id, button) => { const registration = client.addHeaderButton({ id, workspaceId, button }); registrations.push(registration); return registration; };
  const pill = (id, button) => { const registration = client.addComposerPill({ id, workspaceId, agentId, button }); registrations.push(registration); return registration; };
  const menu = { kind: "menu", items: [
    { kind: "item", id: "run", title: "Run checks", icon: "Play", behavior: { kind: "action", onPress() { checks.update({ label: "Checks passed" }); } } },
    { kind: "separator", id: "divider" },
    { kind: "item", id: "environment", title: "Environment", behavior: { kind: "menu", items: [
      { kind: "item", id: "staging", title: "Staging", icon: "FlaskConical", behavior: { kind: "action", onPress() {} } },
      { kind: "item", id: "production", title: "Production", icon: "Globe", disabled: true, behavior: { kind: "action", onPress() {} } },
    ] } },
    { kind: "item", id: "details", title: "Deployment details", icon: "Activity", behavior: { kind: "popover", Content: Details } },
  ] };
  const deploy = header("deploy", { title: "Deploy application", icon: "Rocket", label: "Deploy", behavior: action });
  const checks = header("checks", { title: "Header checks", icon: "ListChecks", label: "Checks", behavior: menu });
  header("status", { title: "Header status", icon: StatusIcon, label: "Healthy", behavior: { kind: "popover", Content: Details } });
  header("logs", { title: "Open deployment logs", icon: "ScrollText", behavior: { kind: "popover", Content: Details } });
  header("locked", { title: "Production locked", icon: "Lock", disabled: true, behavior: { kind: "action", onPress() {} } });
  const review = pill("review", { title: "Run review", icon: "Scan", label: "Review", behavior: { kind: "action", async onPress() { await new Promise((resolve) => { finishReview = resolve; }); review.update({ label: "Reviewed" }); } } });
  const pillMenu = pill("checks", { title: "Composer checks", icon: "ListChecks", label: "Checks", behavior: menu });
  pill("usage", { title: "Composer status", icon: StatusIcon, label: "Status", behavior: { kind: "popover", Content: Details } });
  const command = (id, title, onSelect) => client.addCommandCenterItem({ id, title, icon: "Settings", context: "workspace", onSelect });
  command("finish", "Finish deployment", () => finish());
  command("finish-review", "Finish review", () => finishReview());
  command("hide-deploy", "Hide deployment button", () => deploy.update({ visible: false }));
  command("show-deploy", "Show deployment button", () => deploy.update({ visible: true }));
  command("hide", "Hide review button", () => review.update({ visible: false }));
  command("show", "Show review button", () => review.update({ visible: true, label: "Review ready" }));
  command("disable", "Disable example buttons", () => { deploy.update({ disabled: true }); review.update({ disabled: true }); });
  command("enable", "Enable example buttons", () => { deploy.update({ disabled: false }); review.update({ disabled: false }); });
  command("icon-only", "Use icon-only header", () => deploy.update({ label: undefined }));
  command("hide-menu", "Hide composer menu", () => pillMenu.update({ visible: false }));
  command("show-menu", "Show composer menu", () => pillMenu.update({ visible: true }));
  const lifetime = new AbortController();
  const applyWorkspace = (workspace) => {
    if (workspace.id !== workspaceId) return;
    deploy.update({ visible: workspace.name !== "Compact checks" });
    pillMenu.update({ visible: workspace.name !== "Hide composer menu" });
  };
  void client.paseo.workspaces.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    subscription.subscribe({
      snapshot({ entries }) { for (const workspace of entries) applyWorkspace(workspace); },
      update(message) { if (message.type === "workspace_update" && message.payload.kind === "upsert") applyWorkspace(message.payload.workspace); },
    });
  }).catch((error) => { if (!lifetime.signal.aborted) console.error(error); });
  return () => { lifetime.abort(); finish(); finishReview(); for (const registration of registrations) registration.remove(); };
}`;
}

async function installShowcase(workspaceId: string, agentId: string) {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-buttons-"));
  await mkdir(path.join(directory, "shared"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), clientSource(workspaceId, agentId));
  await writeFile(
    path.join(directory, "shared/rpc.ts"),
    `import { defineRpc } from "@getpaseo/plugin"; import { z } from "zod"; export const summary = defineRpc({ name: "summary", input: z.object({}), output: z.object({ message: z.string() }) });`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { summary } from "./shared/rpc"; export default function contribute(server) { server.handle(summary, async () => ({ message: "All systems operational" })); return () => {}; }`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return {
    disable: () => client.disablePlugin(PLUGIN_ID),
    setTitle: (title: string) => client.setWorkspaceTitle(workspaceId, title),
    async cleanup() {
      await client.removePlugin(PLUGIN_ID);
      await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function press(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).click();
}

async function openHeaderOverflow(page: Page) {
  await page
    .getByRole("toolbar", { name: "Workspace actions", exact: true })
    .getByRole("button", { name: "More actions", exact: true })
    .click();
}

async function choose(page: Page, title: string) {
  await page.getByRole("menuitem", { name: title, exact: true }).click();
}

async function command(page: Page, title: string) {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

/** The command center opens from the sidebar, which compact layouts keep closed. */
async function commandFromCompact(page: Page, title: string) {
  await page.setViewportSize(WIDE);
  await command(page, title);
  await page.setViewportSize(COMPACT);
}

async function expectSurfaceVisible(
  page: Page,
  subject: Locator = page.getByRole("toolbar", { name: "Workspace actions", exact: true }),
) {
  await expect(subject).toBeInViewport();
}

async function expectDetails(page: Page) {
  await expect(page.getByText("All systems operational", { exact: true })).toBeInViewport();
}

function workspaceMenuRow(page: Page, title: string): Locator {
  return compactWorkspaceMenu(page).getByRole("menuitem", { name: title, exact: true });
}

async function expectWorkspaceMenuRows(page: Page, titles: readonly string[]) {
  const rows = compactWorkspaceMenu(page).getByRole("menuitem");
  for (const [index, title] of titles.entries()) {
    await expect(rows.nth(index)).toHaveAccessibleName(title);
  }
}

async function chooseInWorkspaceMenu(page: Page, title: string) {
  await workspaceMenuRow(page, title).click();
}

async function expectWorkspaceMenuClosed(page: Page) {
  await expect(compactWorkspaceMenu(page)).toBeHidden({ timeout: 10_000 });
}

async function expectCompactDetails(page: Page) {
  const menu = compactWorkspaceMenu(page);
  await expect(menu.getByText("All systems operational", { exact: true })).toBeInViewport();
  await expect(menu.getByText("Presentation: compact", { exact: true })).toBeVisible();
}

/** Resolves once `subject` renders the same pixels twice in a row: entering animations are done. */
async function expectStill(subject: Locator) {
  let previous: Buffer | null = null;
  await expect
    .poll(
      async () => {
        const current = await subject.screenshot();
        const still = previous !== null && current.equals(previous);
        previous = current;
        return still;
      },
      { intervals: [150] },
    )
    .toBe(true);
}

/** Attaches the screen once per colour scheme, for review alongside the run. */
async function captureSchemes(page: Page, info: TestInfo, name: string, subject: Locator) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectStill(subject);
    const file = info.outputPath(`${name}-${colorScheme}.png`);
    await info.attach(`${name}-${colorScheme}`, {
      body: await page.screenshot({ path: file }),
      contentType: "image/png",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function expectHeaderTextTruncated(page: Page) {
  const title = page.getByTestId("workspace-header-title");
  const subtitle = page.getByTestId("workspace-header-subtitle");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expect(subtitle).toHaveCSS("text-overflow", "ellipsis");
  // The text itself must overflow its box, rather than being clipped by an ancestor.
  await expect
    .poll(() => title.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await expect
    .poll(() => subtitle.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  const titleBox = await title.boundingBox();
  const subtitleBox = await subtitle.boundingBox();
  const actionsBox = await page
    .getByRole("button", { name: "Workspace actions", exact: true })
    .boundingBox();
  expect(titleBox).not.toBeNull();
  expect(subtitleBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(actionsBox!.x);
  expect(subtitleBox!.x + subtitleBox!.width).toBeLessThanOrEqual(actionsBox!.x);
  const hostIcon = page.getByLabel("localhost", { exact: true }).locator("svg");
  await expect.poll(async () => (await hostIcon.boundingBox())?.width).toBe(12);
}

export async function withButtonShowcase(
  page: Page,
  info: TestInfo,
  run: (buttons: {
    openWideMenusAndPopovers(): Promise<void>;
    runAndUpdateActions(): Promise<void>;
    openCompactSheets(): Promise<void>;
    useCompactWorkspaceMenu(): Promise<void>;
    hideAndUnloadOpenButtons(): Promise<void>;
    verifyObservationLifetime(): Promise<void>;
  }) => Promise<void>,
) {
  const released = new Set<string>();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.message?.type === "subscription.release.response")
        released.add(frame.message.payload.subscriptionId);
    }),
  );
  const workspace = await seedWorkspace({ repoPrefix: "plugin-buttons-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Button showcase",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const showcase = await installShowcase(workspace.workspaceId, agent.id);
  try {
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));
    await expect(page.getByRole("button", { name: "Run review", exact: true })).toBeVisible();

    await run({
      verifyObservationLifetime: () =>
        test.step("closing and crashing content release its owner while sibling buttons and app remain live", async () => {
          await press(page, "Header status");
          await expectDetails(page);
          const observation = page.getByLabel("Content observation", { exact: true });
          await expect(observation).not.toHaveText("");
          const first = (await observation.textContent())!;
          await press(page, "Close deployment details");
          await expect.poll(() => released.has(first)).toBe(true);
          await press(page, "Composer status");
          await expectDetails(page);
          const second = (await observation.textContent())!;
          expect(second).not.toBe(first);
          await workspace.client.renameProject(workspace.projectId, "Observer control");
          await expect(page.getByText("Observed updates: 1", { exact: true })).toBeVisible();
          await press(page, "Fail button content");
          await expect(
            page.getByText("Plugin failed: Button content failed", { exact: true }),
          ).toBeVisible();
          await expect.poll(() => released.has(second)).toBe(true);
          await page.keyboard.press("Escape");
          await press(page, "Header status");
          await expectDetails(page);
          const recovered = (await observation.textContent())!;
          expect([first, second]).not.toContain(recovered);
          await showcase.setTitle("Healthy app after button failure");
          await expect(page.getByTestId("workspace-header-title")).toHaveText(
            "Healthy app after button failure",
          );
          await press(page, "Close deployment details");
          await expect.poll(() => released.has(recovered)).toBe(true);
          await showcase.setTitle("Button showcase");
        }),
      openWideMenusAndPopovers: () =>
        test.step("wide buttons have placement-owned labels and chevrons", async () => {
          await expect(
            page
              .getByRole("button", { name: "Header checks", exact: true })
              .getByTestId("plugin-button-chevron"),
          ).toHaveCount(1);
          await expect(
            page
              .getByRole("button", { name: "Composer checks", exact: true })
              .getByTestId("plugin-button-chevron"),
          ).toHaveCount(0);
          await expectSurfaceVisible(page);
          await captureSchemes(
            page,
            info,
            "desktop-wide-header",
            page.getByRole("toolbar", { name: "Workspace actions", exact: true }),
          );
          await press(page, "Header checks");
          await expect(
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          ).toBeVisible();
          await expectSurfaceVisible(
            page,
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Environment");
          await expect(page.getByRole("menuitem", { name: "Staging", exact: true })).toBeVisible();
          await expectSurfaceVisible(
            page,
            page.getByRole("menuitem", { name: "Staging", exact: true }),
          );
          await choose(page, "Staging");
          await openHeaderOverflow(page);
          await expect(
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          ).toBeDisabled();
          await captureSchemes(
            page,
            info,
            "desktop-overflow",
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          );
          await expectSurfaceVisible(
            page,
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          );
          await choose(page, "Open deployment logs");
          await expectDetails(page);
          await press(page, "Close deployment details");
          await press(page, "Header status");
          await expectDetails(page);
          await expectSurfaceVisible(
            page,
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer checks");
          await expectSurfaceVisible(
            page,
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Deployment details");
          await expectDetails(page);
          await expectSurfaceVisible(
            page,
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer status");
          await expectDetails(page);
          await expectSurfaceVisible(
            page,
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
        }),
      runAndUpdateActions: () =>
        test.step("actions fail visibly, retry, and remain busy until completion", async () => {
          await press(page, "Deploy application");
          await expect(
            page.getByText("Deployment failed. Try again.", { exact: true }),
          ).toBeVisible();
          await expectSurfaceVisible(
            page,
            page.getByText("Deployment failed. Try again.", { exact: true }),
          );
          await press(page, "Deploy application");
          await expect(
            page.getByRole("button", { name: "Deploy application", exact: true }),
          ).toBeDisabled();
          await expectSurfaceVisible(page);
          await command(page, "Finish deployment");
          await expect(
            page.getByRole("button", { name: "Deploy application", exact: true }),
          ).toContainText("Deployed");
          await press(page, "Run review");
          await expect(
            page.getByRole("button", { name: "Run review", exact: true }),
          ).toBeDisabled();
          await expectSurfaceVisible(page);
          await command(page, "Finish review");
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toContainText(
            "Reviewed",
          );
          await command(page, "Disable example buttons");
          await expect(
            page.getByRole("button", { name: "Run review", exact: true }),
          ).toBeDisabled();
          await expectSurfaceVisible(page);
          await command(page, "Enable example buttons");
          await command(page, "Use icon-only header");
          await expect(
            page.getByRole("button", { name: "Deploy application", exact: true }),
          ).toHaveText("");
          await expectSurfaceVisible(page);
          await expect(
            page.getByText("Deployment failed. Try again.", { exact: true }),
          ).toHaveCount(0);
          await captureSchemes(
            page,
            info,
            "desktop-icon-only-header",
            page.getByRole("toolbar", { name: "Workspace actions", exact: true }),
          );
          await command(page, "Hide review button");
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toHaveCount(
            0,
          );
          await command(page, "Show review button");
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toContainText(
            "Review ready",
          );
        }),
      openCompactSheets: () =>
        test.step("compact header leaves plugin actions to the workspace menu while composer triggers open sheets", async () => {
          await page.setViewportSize(COMPACT);
          await expect(page.getByTestId("plugin-button-chevron")).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Composer checks", exact: true }),
          ).toContainText("Checks");
          await workspace.client.renameProject(
            workspace.projectId,
            "Plugin buttons with a long project name",
          );
          await expect(page.getByTestId("workspace-header-subtitle")).toHaveText(
            "Plugin buttons with a long project name",
          );
          await showcase.setTitle("Button showcase with a long workspace title");
          await expect(page.getByTestId("workspace-header-title")).toHaveText(
            "Button showcase with a long workspace title",
          );
          await expectHeaderTextTruncated(page);
          await expect(
            page.getByRole("toolbar", { name: "Workspace actions", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Open menu", exact: true }),
          ).toBeInViewport();
          await showcase.setTitle("Button showcase");
          await press(page, "Composer status");
          await expectDetails(page);
          await expectSurfaceVisible(
            page,
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer checks");
          await expectSurfaceVisible(
            page,
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Run checks");
        }),
      useCompactWorkspaceMenu: () =>
        test.step("compact workspace menu carries header buttons with their actions, menus, and content", async () => {
          await openCompactWorkspaceMenu(page);
          await expectWorkspaceMenuRows(page, [
            "Deploy application",
            "Header checks",
            "Header status",
            "Open deployment logs",
            "Production locked",
            "Copy workspace path",
          ]);
          await expect(workspaceMenuRow(page, "Production locked")).toBeDisabled();
          // Deploy lost its label to "Use icon-only header" and logs never had one; rows read titles.
          await expect(workspaceMenuRow(page, "Deploy application")).toHaveText(
            "Deploy application",
          );
          await expect(workspaceMenuRow(page, "Open deployment logs")).toHaveText(
            "Open deployment logs",
          );
          await captureSchemes(page, info, "compact-root-icon-only", compactWorkspaceMenu(page));

          await showcase.setTitle("Compact checks");
          await expect(workspaceMenuRow(page, "Deploy application")).toHaveCount(0);
          await showcase.setTitle("Button showcase");
          await expect(workspaceMenuRow(page, "Deploy application")).toBeVisible();

          await chooseInWorkspaceMenu(page, "Deploy application");
          await expectWorkspaceMenuClosed(page);
          await expect(
            page.getByText("Deployment failed. Try again.", { exact: true }),
          ).toBeVisible();
          await openCompactWorkspaceMenu(page);
          await chooseInWorkspaceMenu(page, "Deploy application");
          await expectWorkspaceMenuClosed(page);
          await openCompactWorkspaceMenu(page);
          await expect(workspaceMenuRow(page, "Deploy application")).toBeDisabled();
          await captureSchemes(page, info, "compact-row-states", compactWorkspaceMenu(page));
          await closeCompactWorkspaceMenu(page);
          await commandFromCompact(page, "Finish deployment");
          await openCompactWorkspaceMenu(page);
          await expect(workspaceMenuRow(page, "Deploy application")).toBeEnabled();
          await captureSchemes(page, info, "compact-root", compactWorkspaceMenu(page));

          await chooseInWorkspaceMenu(page, "Header checks");
          await expectWorkspaceMenuRows(page, ["Run checks", "Environment", "Deployment details"]);
          await captureSchemes(page, info, "compact-header-checks", compactWorkspaceMenu(page));
          await goBackInMenu(page);
          await expect(workspaceMenuRow(page, "Header status")).toBeVisible();
          await chooseInWorkspaceMenu(page, "Header checks");
          await chooseInWorkspaceMenu(page, "Environment");
          await expectWorkspaceMenuRows(page, ["Staging", "Production"]);
          await expect(workspaceMenuRow(page, "Production")).toBeDisabled();
          await captureSchemes(page, info, "compact-environment", compactWorkspaceMenu(page));
          await goBackInMenu(page);
          await expect(workspaceMenuRow(page, "Run checks")).toBeVisible();
          await goBackInMenu(page);
          await expect(workspaceMenuRow(page, "Header checks")).toBeVisible();

          await chooseInWorkspaceMenu(page, "Header checks");
          await chooseInWorkspaceMenu(page, "Deployment details");
          await expectCompactDetails(page);
          await captureSchemes(
            page,
            info,
            "compact-deployment-details",
            compactWorkspaceMenu(page),
          );
          await goBackInMenu(page);
          await expect(workspaceMenuRow(page, "Run checks")).toBeVisible();
          await chooseInWorkspaceMenu(page, "Deployment details");
          await expectCompactDetails(page);
          await press(page, "Close deployment details");
          await expectWorkspaceMenuClosed(page);

          await openCompactWorkspaceMenu(page);
          await chooseInWorkspaceMenu(page, "Header status");
          await expectCompactDetails(page);
          await captureSchemes(page, info, "compact-header-status", compactWorkspaceMenu(page));
          await press(page, "Fail button content");
          await expect(
            compactWorkspaceMenu(page).getByText("Plugin failed: Button content failed", {
              exact: true,
            }),
          ).toBeVisible();
          await goBackInMenu(page);
          await expect(workspaceMenuRow(page, "Header status")).toBeVisible();
          await chooseInWorkspaceMenu(page, "Open deployment logs");
          await expectCompactDetails(page);
          await captureSchemes(page, info, "compact-logs-popover", compactWorkspaceMenu(page));
          await press(page, "Close deployment details");
          await expectWorkspaceMenuClosed(page);
        }),
      hideAndUnloadOpenButtons: () =>
        test.step("hiding an open button and unloading a plugin remove its surfaces", async () => {
          await page.setViewportSize(WIDE);
          await press(page, "Composer checks");
          await showcase.setTitle("Hide composer menu");
          await expect(page.getByRole("menuitem", { name: "Run checks", exact: true })).toHaveCount(
            0,
          );
          await expect(
            page.getByRole("button", { name: "Composer checks", exact: true }),
          ).toHaveCount(0);
          await showcase.setTitle("Button showcase");
          await page.emulateMedia({ colorScheme: "dark" });
          await expectSurfaceVisible(page);
          await press(page, "Header status");
          await expectDetails(page);
          await expectSurfaceVisible(
            page,
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          const observation = page.getByLabel("Content observation", { exact: true });
          await expect(observation).not.toHaveText("");
          const owner = (await observation.textContent())!;
          await showcase.disable();
          await expect.poll(() => released.has(owner)).toBe(true);
          await expect(
            page.getByRole("button", { name: "Header status", exact: true }),
          ).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toHaveCount(
            0,
          );
          await expect(page.getByText("All systems operational", { exact: true })).toHaveCount(0);
          await page.setViewportSize(COMPACT);
          await openCompactWorkspaceMenu(page);
          await expect(workspaceMenuRow(page, "Header checks")).toHaveCount(0);
          await expect(workspaceMenuRow(page, "Header status")).toHaveCount(0);
          await closeCompactWorkspaceMenu(page);
          await page.setViewportSize(WIDE);
          await showcase.setTitle("Healthy app after plugin unload");
          await expect(page.getByTestId("workspace-header-title")).toHaveText(
            "Healthy app after plugin unload",
          );
        }),
    });
  } finally {
    await showcase.cleanup();
    await workspace.cleanup();
  }
}
