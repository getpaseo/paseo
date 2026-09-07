import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";

const PLUGIN_ID = "plugin-host-ui-e2e";

const PLUGIN_SOURCE = `import { usePaseo } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/react-native";
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
