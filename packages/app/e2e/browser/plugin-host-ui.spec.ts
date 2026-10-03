import { copyPluginExample, pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settingsRpc } from "@getpaseo/plugin";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { fillNewWorkspaceDraft, openProjectViaDaemon } from "../support/helpers/new-workspace";
import { delayBrowserWorkspaceCreatedResponse } from "../support/helpers/new-workspace";
import { attachImageFromMenu } from "../support/helpers/composer";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";

const PLUGIN_ID = "plugin-host-ui-e2e";

const PLUGIN_SOURCE = `import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

function ModalBody({ onSaved }) {
  usePaseo();
  useQueryClient();
  const toast = useToast();

  function save() {
    toast.show("Issue saved", { variant: "success" });
    onSaved();
  }

  return <View>
    <Text>Plugin modal contexts ready</Text>
    <Pressable accessibilityRole="button" onPress={save}>
      <Text>Save issue</Text>
    </Pressable>
  </View>;
}

function Surface() {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
      <View style={{ flexDirection: "row" }}>
        <Icon name="Pencil" size={18} />
        <Text>Open plugin modal</Text>
      </View>
    </Pressable>
    <Modal
      title="Edit plugin issue"
      icon={<Icon name="Pencil" size={18} />}
      open={open}
      onOpenChange={setOpen}
    >
      <Modal.Content>
        <ModalBody onSaved={() => setOpen(false)} />
      </Modal.Content>
    </Modal>
  </View>;
}

export default function contribute(plugin) {
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({
    id: "main",
    title: "Host UI",
    icon: "PanelsTopLeft",
    surface: "main",
  });
  return () => {};
}`;

async function openHostUiPlugin(page: Page): Promise<void> {
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Host UI", exact: true }).click();
}

async function useNonCompactLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 800 });
}

async function useCompactLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
}

async function reopenHostUiPluginFromCompactSidebar(page: Page): Promise<void> {
  await openMobileAgentSidebar(page);
  await expectMobileAgentSidebarVisible(page);
  await page.getByRole("button", { name: "Host UI", exact: true }).click();
}

async function openPluginModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open plugin modal", exact: true }).click();
}

async function expectCenteredPluginDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Edit plugin issue", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Plugin modal contexts ready", { exact: true })).toBeVisible();
}

async function closeCenteredPluginDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function expectCompactPluginSheet(page: Page): Promise<void> {
  await expect(page.getByText("Edit plugin issue", { exact: true })).toBeVisible();
  await expect(page.getByText("Plugin modal contexts ready", { exact: true })).toBeVisible();
}

async function savePluginIssue(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save issue", exact: true }).click();
  await expect(page.getByText("Issue saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Plugin modal contexts ready", { exact: true })).not.toBeVisible();
}

test("plugin modal adapts its presentation and preserves host contexts", async ({ page }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-host-ui-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await useNonCompactLayout(page);
    await openHostUiPlugin(page);

    await test.step("non-compact layouts use a centered dialog", async () => {
      await openPluginModal(page);
      await expectCenteredPluginDialog(page);
      await closeCenteredPluginDialog(page);
    });

    await test.step("compact layouts preserve host contexts inside a sheet", async () => {
      await useCompactLayout(page);
      await reopenHostUiPluginFromCompactSidebar(page);
      await openPluginModal(page);
      await expectCompactPluginSheet(page);
      await savePluginIssue(page);
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const compact of [false, true]) {
  test(`submission checks protect Direct and plugin starts before creating a workspace (${compact ? "compact" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-submission-ui-e2e-"));
    const source = await createTempGitRepo("submission-source-");
    const target = await createTempGitRepo("submission-target-");
    const client = await connectNewWorkspaceDaemonClient();
    const previous = await client.getDaemonConfig();
    const pluginId = "submission-check-e2e";
    try {
      const original = await openProjectViaDaemon(client, source.path);
      const destination = await openProjectViaDaemon(client, target.path);
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
      );
      await writeFile(
        path.join(directory, "index.client.tsx"),
        `export default function contribute(plugin) {
        plugin.addSubmissionCheck({
          id: "target",
          async check(input) {
            if (input.defaultAgentConfig?.provider !== "mock/ten-second-stream" || input.routingMode !== "manual")
              throw new Error("This fixture only starts a manually selected mock model");
            globalThis.__submissionRequest = input;
            return {
              title: "Choose the request project",
              choices: [{ id: "keep", title: "Keep project" }, { id: "new", title: "New project" }],
              textInput: { label: "Project name", initialValue: "kin" },
              timeout: { seconds: 3, choiceId: "keep" }
            };
          },
          async resolve(input, choice) {
            globalThis.__submissionChoice = choice;
            return choice.choiceId === "new" ? ${JSON.stringify({ cwd: target.path, projectId: destination.projectId })} : undefined;
          }
        });
        plugin.addExecutionMode({
          id: "team", title: "Fixture team", icon: "Users",
          async loadPresets() { return { presets: [{ id: "standard", title: "Standard fixture" }], defaultPresetId: "standard" }; },
          async start(input) {
            const agent = await plugin.paseo.agents.create({
              workspaceId: input.workspaceId, cwd: input.cwd,
              config: { provider: "mock/e2e-fast-stream", modeId: "load-test" }, initialPrompt: input.text
            });
            return { agentId: agent.id };
          }
        });
        return () => {};
      }`,
      );
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(directory);
      await page.setViewportSize({ width: compact ? 390 : 1100, height: compact ? 844 : 800 });
      await gotoAppShell(page);
      const route = buildNewWorkspaceRoute({
        serverId: getServerId(),
        projectId: original.projectId,
        sourceDirectory: source.path,
        displayName: original.projectDisplayName,
      });
      await page.goto(route);
      if (!compact) {
        await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
        const modelProvider = page.getByTestId("model-provider-mock");
        if (!(await modelProvider.isVisible())) {
          await page.getByRole("button", { name: "Back", exact: true }).last().click();
        }
        await modelProvider.click();
        await page.getByTestId("model-row-mock-ten-second-stream").click();
      }
      await expect(
        page.getByTestId("combined-model-selector").filter({ visible: true }),
      ).toContainText("Ten second stream");
      await fillNewWorkspaceDraft(page, "Build the new product in its own project");
      const before = (await client.fetchWorkspaces()).entries.length;
      await page.getByTestId("workspace-create-submit").click();
      const sheet = page.getByTestId("plugin-submission-decision");
      await expect(sheet).toBeVisible();
      await page.getByRole("textbox", { name: "Project name" }).focus();
      await expect(
        page.getByText("Automatic selection paused. Choose when you are ready."),
      ).toBeVisible();
      expect((await client.fetchWorkspaces()).entries).toHaveLength(before);
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(sheet).not.toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(
        "Build the new product in its own project",
      );
      expect((await client.fetchWorkspaces()).entries).toHaveLength(before);
      await page.getByTestId("workspace-create-submit").click();
      await expect(sheet).toBeVisible();
      await page.getByRole("textbox", { name: "Project name" }).fill("new-product");
      await expect(page.getByRole("button", { name: "New project", exact: true })).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`submission-decision-${compact ? "compact" : "desktop"}.png`),
      });
      await page.getByRole("button", { name: "New project", exact: true }).click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const direct = (await client.fetchWorkspaces()).entries.find(
        (entry) =>
          entry.projectId === destination.projectId && entry.id !== destination.workspaceId,
      );
      expect(direct?.projectRootPath).toBe(target.path);
      expect(direct?.workspaceDirectory).not.toContain(source.path);
      await page.goto(route);
      await page.getByRole("button", { name: "Execution mode", exact: true }).click();
      await page.getByRole("button", { name: "Fixture team", exact: true }).click();
      await fillNewWorkspaceDraft(page, "Run the fixture team in the new project");
      const beforeTeam = (await client.fetchWorkspaces()).entries.length;
      await page.getByTestId("workspace-create-submit").click();
      await expect(sheet).toBeVisible();
      expect((await client.fetchWorkspaces()).entries).toHaveLength(beforeTeam);
      await page.getByRole("button", { name: "New project", exact: true }).click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      expect(
        (await client.fetchWorkspaces()).entries.filter(
          (entry) => entry.projectId === destination.projectId,
        ),
      ).toHaveLength(3);
      const agents = await client.fetchAgents();
      expect(agents.entries.map((entry) => entry.agent.provider)).toEqual(["mock", "mock"]);
    } finally {
      await client.removePlugin(pluginId).catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
      await source.cleanup();
      await target.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const compact of [false, true]) {
  test(`project intake creates an isolated Git project through the native start form (${compact ? "compact" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const parent = await mkdtemp(path.join(tmpdir(), "project-intake-products-"));
    const source = await createTempGitRepo("project-intake-source-");
    const example = await copyPluginExample("project-intake");
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "project-intake-ui" });
    const beforeConfig = await client.getDaemonConfig();
    const previousProjects = new Set(
      (await client.listProjects()).projects.map((project) => project.projectId),
    );
    const git = promisify(execFile);
    const head = (await git("git", ["rev-parse", "HEAD"], { cwd: source.path })).stdout;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const prompt = "Build a new Kin product with its own application";
    try {
      const original = await openProjectViaDaemon(client, source.path);
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(example.directory);
      const settings = settingsRpc("intake");
      const current = settings.read.output.parse(
        await client.invokePluginRpc("project-intake", settings.read.name, {}),
      );
      expect(current.status).toBe("ready");
      if (current.status !== "ready") throw new Error(current.error);
      const saved = settings.write.output.parse(
        await client.invokePluginRpc("project-intake", settings.write.name, {
          revision: current.revision,
          values: { ...(current.values as object), useSystemOne: false, newProjectParent: parent },
        }),
      );
      expect(saved.status).toBe("saved");
      const intent = await delayBrowserWorkspaceCreatedResponse(page);
      intent.release();
      await page.setViewportSize({ width: compact ? 390 : 1100, height: compact ? 844 : 800 });
      await gotoAppShell(page);
      await page.goto(
        buildNewWorkspaceRoute({
          serverId: getServerId(),
          projectId: original.projectId,
          sourceDirectory: source.path,
          displayName: original.projectDisplayName,
        }),
      );
      await expect(
        page.getByTestId("combined-model-selector").filter({ visible: true }),
      ).toContainText("Ten second stream");
      await fillNewWorkspaceDraft(page, prompt);
      await attachImageFromMenu(page, {
        name: "reference.png",
        mimeType: "image/png",
        buffer: png,
      });
      const workspaceCount = (await client.fetchWorkspaces()).entries.length;
      await page.getByTestId("workspace-create-submit").click();
      const decision = page.getByTestId("plugin-submission-decision");
      await expect(decision).toBeVisible();
      await expect(
        page.getByText("Which project should do this work?", { exact: true }),
      ).toBeVisible();
      expect(await readdir(parent)).toEqual([]);
      expect((await client.fetchWorkspaces()).entries).toHaveLength(workspaceCount);
      expect(intent.agentRequests).toHaveLength(0);
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(decision).not.toBeVisible();
      expect(await readdir(parent)).toEqual([]);
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(prompt);
      await page.getByTestId("workspace-create-submit").click();
      await expect(decision).toBeVisible();
      await page.getByRole("textbox", { name: "New project name" }).fill("kin-product");
      await expect(
        page.getByText("Automatic selection paused. Choose when you are ready.", { exact: true }),
      ).toBeVisible();
      const create = page.getByRole("button", { name: "Create a separate project", exact: true });
      await expect(create).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`project-intake-${compact ? "compact" : "desktop"}.png`),
      });
      await create.click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const root = path.join(parent, "kin-product");
      const project = (await client.listProjects()).projects.find(
        (entry) => entry.projectRootPath === root,
      );
      expect(project?.projectId).toBeTruthy();
      expect(project?.projectId).not.toBe(original.projectId);
      const workspaces = (await client.fetchWorkspaces()).entries.filter(
        (entry) => entry.projectId === project?.projectId,
      );
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.projectRootPath).toBe(root);
      expect(
        (await git("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim(),
      ).toBe(root);
      expect((await git("git", ["rev-parse", "HEAD"], { cwd: source.path })).stdout).toBe(head);
      expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("# kin-product");
      expect(intent.agentRequests).toHaveLength(1);
      expect(intent.agentRequests[0]).toMatchObject({
        config: { provider: "mock", model: "ten-second-stream" },
        initialPrompt: prompt,
        images: [{ data: png.toString("base64"), mimeType: "image/png" }],
      });
      expect((await client.fetchAgents()).entries.map((entry) => entry.agent.provider)).toEqual([
        "mock",
      ]);
    } finally {
      await client.removePlugin("project-intake").catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: beforeConfig.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      for (const project of (await client.listProjects()).projects) {
        if (!previousProjects.has(project.projectId))
          await client.removeProject(project.projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await example.cleanup();
      await source.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });
}
