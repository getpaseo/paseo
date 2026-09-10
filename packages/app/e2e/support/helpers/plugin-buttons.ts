import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { test, expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { buildAgentRoute } from "./mock-agent";
import { openCommandCenter } from "./command-center";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import { pluginRequirements } from "./plugin-fixture";
import { waitForSettledPosition } from "./sheet-layout";

const PLUGIN_ID = "button-showcase";
const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

function clientSource(workspaceId: string, agentId: string): string {
  return `import React from "react";
import { Text, View, Pressable } from "react-native";
import { useWorkspace, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { summary } from "./shared/rpc";

function StatusIcon({ size, theme }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.statusSuccess }} />;
}

function Details({ workspaceId, theme, layout, close }) {
  const workspace = useWorkspace(workspaceId, (workspace) => workspace.name);
  const rpc = useRpc(summary);
  const query = useQuery({ queryKey: ["summary"], queryFn: () => rpc({}) });
  return <View style={{ gap: 12 }}>
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
    if (++attempts === 1) throw new Error("Deployment failed. Try again.");
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
  const unsubscribe = client.paseo.workspaces.ref(workspaceId).subscribe((update) => {
    if (update.kind !== "upsert") return;
    deploy.update({ visible: update.workspace.name !== "Compact checks" });
    pillMenu.update({ visible: update.workspace.name !== "Hide composer menu" });
  });
  return () => { unsubscribe(); finish(); finishReview(); for (const registration of registrations) registration.remove(); };
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

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  subject: Locator = page.getByRole("toolbar", { name: "Workspace actions", exact: true }),
) {
  await expect(subject).toBeInViewport();
  await waitForSettledPosition(subject);
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

async function expectDetails(page: Page) {
  await expect(page.getByText("All systems operational", { exact: true })).toBeInViewport();
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

async function holdButton(page: Page, button: Locator) {
  await button.hover();
  await page.mouse.down();
}

async function openCompactOverflowWithHeaderChrome(page: Page, testInfo: TestInfo) {
  const hamburger = page.getByRole("button", { name: "Open menu", exact: true });
  const action = page.getByRole("button", { name: "Deploy application", exact: true });
  const overflow = page
    .getByRole("toolbar", { name: "Workspace actions", exact: true })
    .getByRole("button", { name: "More actions", exact: true });
  await expect(action).toHaveCSS("border-top-width", "0px");
  await expect(overflow).toHaveCSS("border-top-width", "0px");
  await hamburger.hover();
  const highlight = await hamburger.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await action.hover();
  await expect(action).toHaveCSS("background-color", highlight);
  await holdButton(page, overflow);
  await expect(overflow).toHaveCSS("background-color", highlight);
  await capture(page, testInfo, "12c-compact-overflow-pressed");
  await page.mouse.up();
}

export async function withButtonShowcase(
  page: Page,
  testInfo: TestInfo,
  run: (buttons: {
    openWideMenusAndPopovers(): Promise<void>;
    runAndUpdateActions(): Promise<void>;
    openCompactSheets(): Promise<void>;
    hideAndUnloadOpenButtons(): Promise<void>;
  }) => Promise<void>,
) {
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
          await capture(page, testInfo, "01-wide-buttons");
          await press(page, "Header checks");
          await expect(
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          ).toBeVisible();
          await capture(
            page,
            testInfo,
            "02-header-menu",
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Environment");
          await expect(page.getByRole("menuitem", { name: "Staging", exact: true })).toBeVisible();
          await capture(
            page,
            testInfo,
            "03-header-submenu",
            page.getByRole("menuitem", { name: "Staging", exact: true }),
          );
          await choose(page, "Staging");
          await openHeaderOverflow(page);
          await expect(
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          ).toBeDisabled();
          await capture(
            page,
            testInfo,
            "03b-wide-overflow",
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          );
          await choose(page, "Open deployment logs");
          await expectDetails(page);
          await press(page, "Close deployment details");
          await press(page, "Header status");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "04-header-popover",
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer checks");
          await capture(
            page,
            testInfo,
            "05-composer-menu",
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Deployment details");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "06-composer-menu-content",
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer status");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "07-composer-popover",
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
          await capture(
            page,
            testInfo,
            "08-action-error",
            page.getByText("Deployment failed. Try again.", { exact: true }),
          );
          await press(page, "Deploy application");
          await expect(
            page.getByRole("button", { name: "Deploy application", exact: true }),
          ).toBeDisabled();
          await capture(page, testInfo, "09-action-pending");
          await command(page, "Finish deployment");
          await expect(
            page.getByRole("button", { name: "Deploy application", exact: true }),
          ).toContainText("Deployed");
          await press(page, "Run review");
          await expect(
            page.getByRole("button", { name: "Run review", exact: true }),
          ).toBeDisabled();
          await capture(page, testInfo, "09b-composer-pending");
          await command(page, "Finish review");
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toContainText(
            "Reviewed",
          );
          await command(page, "Disable example buttons");
          await expect(
            page.getByRole("button", { name: "Run review", exact: true }),
          ).toBeDisabled();
          await capture(page, testInfo, "10-disabled-buttons");
          await command(page, "Enable example buttons");
          await command(page, "Use icon-only header");
          await capture(page, testInfo, "11-icon-only-header");
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
        test.step("compact triggers and overflow open sheets with working plugin context", async () => {
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
          await capture(page, testInfo, "12-compact-buttons");
          await openCompactOverflowWithHeaderChrome(page, testInfo);
          await expect(
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          ).toBeDisabled();
          await capture(
            page,
            testInfo,
            "13-compact-header-overflow",
            page.getByRole("menuitem", { name: "Production locked", exact: true }),
          );
          await choose(page, "Header checks");
          await capture(
            page,
            testInfo,
            "14-compact-header-menu",
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Deployment details");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "15-compact-header-content",
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await showcase.setTitle("Compact checks");
          await press(page, "Header checks");
          await expect(
            page
              .getByRole("button", { name: "Header checks", exact: true })
              .getByTestId("plugin-button-chevron"),
          ).toHaveCount(0);
          await capture(
            page,
            testInfo,
            "15b-compact-header-direct-menu",
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Run checks");
          await showcase.setTitle("Button showcase");
          await press(page, "Composer status");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "16-compact-composer-popover",
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await press(page, "Close deployment details");
          await press(page, "Composer checks");
          await capture(
            page,
            testInfo,
            "17-compact-composer-menu",
            page.getByRole("menuitem", { name: "Run checks", exact: true }),
          );
          await choose(page, "Run checks");
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
          await capture(page, testInfo, "18-dark-buttons");
          await press(page, "Header status");
          await expectDetails(page);
          await capture(
            page,
            testInfo,
            "19-dark-popover",
            page.getByRole("button", { name: "Close deployment details", exact: true }),
          );
          await showcase.disable();
          await expect(
            page.getByRole("button", { name: "Header status", exact: true }),
          ).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Run review", exact: true })).toHaveCount(
            0,
          );
          await expect(page.getByText("All systems operational", { exact: true })).toHaveCount(0);
        }),
    });
  } finally {
    await showcase.cleanup();
    await workspace.cleanup();
  }
}
