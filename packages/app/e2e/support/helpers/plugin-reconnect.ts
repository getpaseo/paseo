import { writeFile } from "node:fs/promises";
import path from "node:path";
import { settingsRpc } from "@getpaseo/plugin";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { expect, type Page } from "../fixtures";
import { gotoAppShell } from "./app";
import { installDaemonWebSocketGate } from "./daemon-websocket-gate";
import { connectDaemonClient } from "./daemon-client-loader";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";

const PLUGIN_ID = "retained-plugin-e2e";

export function retainedPluginSource(version: string) {
  return `import { useState } from "react";
import { Text, View, TextInput, Pressable } from "react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { preferences } from "./shared/preferences";
function Preferences({ color }) {
  const settings = useSettings(preferences);
  return <Text style={{ color }}>{settings.status === "ready" ? "Stored title: " + settings.values.title : "Preferences " + settings.status}</Text>;
}
function Surface({ theme }) {
  const [draft, setDraft] = useState("");
  const [clicks, setClicks] = useState(0);
  const [showPreferences, setShowPreferences] = useState(true);
  const color = theme.colors.foreground;
  return <View>
    <Text style={{ color }}>Plugin version ${version}</Text>
    <TextInput accessibilityLabel="Plugin draft" value={draft} onChangeText={setDraft} style={{ color }} />
    <Pressable accessibilityRole="button" onPress={() => setClicks(value => value + 1)}><Text style={{ color }}>{"Local clicks " + clicks}</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => setShowPreferences(value => !value)}><Text style={{ color }}>{showPreferences ? "Hide preferences" : "Show preferences"}</Text></Pressable>
    {showPreferences ? <Preferences color={color} /> : null}
  </View>;
}
export default function contribute(plugin) {
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: "Reconnect probe", icon: "PanelsTopLeft", surface: "main" });
  return () => {};
}`;
}

export async function withRetainedPlugin(
  page: Page,
  run: (probe: Awaited<ReturnType<typeof createProbe>>) => Promise<void>,
) {
  const probe = await createProbe(page);
  try {
    await run(probe);
  } finally {
    await probe.close();
  }
}

async function createProbe(page: Page) {
  const example = await copyPluginExample("settings");
  const peer = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "plugin-reconnect" });
  const previous = await peer.getDaemonConfig();
  const gate = await installDaemonWebSocketGate(page);
  const clientEntry = path.join(example.directory, "index.client.tsx");
  let catalogCount = 0;
  try {
    await writeFile(
      path.join(example.directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(clientEntry, retainedPluginSource("one"));
    await peer.patchDaemonConfig({ pluginsEnabled: true });
    await peer.installDirectoryPlugin(example.directory);
  } catch (error) {
    await peer.close();
    await example.cleanup();
    throw error;
  }
  return {
    async open() {
      await page.setViewportSize({ width: 1100, height: 800 });
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Reconnect probe", exact: true }).click();
      await expect(page.getByText("Stored title: Agent monitor", { exact: true })).toBeVisible();
    },
    async disconnect() {
      catalogCount = gate.getClientRequestCount("plugin.catalog.get.request");
      await gate.drop();
      await gate.waitForBlockedConnection();
    },
    async reconnect() {
      gate.restore();
      await gate.waitForServerMessage("plugin.catalog.get.response", catalogCount + 1);
    },
    async changeStoredTitle(title: string) {
      const rpc = settingsRpc("display");
      const current = rpc.read.output.parse(
        await peer.invokePluginRpc(PLUGIN_ID, rpc.read.name, {}),
      );
      if (current.status !== "ready") throw new Error("Expected ready settings");
      const values = z
        .object({ groupBy: z.string(), showMetadata: z.boolean(), title: z.string() })
        .parse(current.values);
      const result = await peer.invokePluginRpc(PLUGIN_ID, rpc.write.name, {
        revision: current.revision,
        values: { ...values, title },
      });
      expect(result).toMatchObject({ status: "saved", values: { title } });
    },
    async changeCode() {
      await writeFile(clientEntry, retainedPluginSource("two"));
      await peer.reloadPlugin(PLUGIN_ID);
    },
    async remove() {
      await peer.removePlugin(PLUGIN_ID);
    },
    async close() {
      gate.restore();
      await peer.removePlugin(PLUGIN_ID).catch(() => undefined);
      await peer.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
      await peer.close();
      await example.cleanup();
    },
  };
}

export async function editRetainedDraft(page: Page, draft: string, clicks: number) {
  await page.getByRole("textbox", { name: "Plugin draft", exact: true }).fill(draft);
  await page.getByRole("button", { name: `Local clicks ${clicks}`, exact: true }).click();
  await expectRetainedDraft(page, draft, clicks + 1);
}

export async function expectRetainedDraft(page: Page, draft: string, clicks: number) {
  await expect(page.getByRole("textbox", { name: "Plugin draft", exact: true })).toHaveValue(draft);
  await expect(
    page.getByRole("button", { name: `Local clicks ${clicks}`, exact: true }),
  ).toBeVisible();
}

export async function expectStoredPluginTitle(page: Page, title: string) {
  await expect(page.getByText(`Stored title: ${title}`, { exact: true })).toBeVisible();
}

export async function hideRetainedPreferences(page: Page) {
  await page.getByRole("button", { name: "Hide preferences", exact: true }).click();
  await expect(page.getByText(/^Stored title:/)).toHaveCount(0);
}

export async function showRetainedPreferences(page: Page) {
  await page.getByRole("button", { name: "Show preferences", exact: true }).click();
}

export async function expectChangedPlugin(page: Page) {
  await expect(page.getByText("Plugin version two", { exact: true })).toBeVisible();
  await expectRetainedDraft(page, "", 0);
}

export async function expectRemovedPlugin(page: Page) {
  await expect(
    page.getByText("This plugin surface is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect probe", exact: true })).toHaveCount(0);
}
