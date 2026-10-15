import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "../fixtures";
import { gotoAppShell } from "./app";
import { addConnectedHostAndReload } from "./hosts";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

const id = "host-clients";
const source = `import { useHosts, getPaseoClient, usePaseo } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
export default function contribute(plugin) {
  function Surface() {
    const hosts = useHosts();
    const selected = usePaseo();
    const [result, setResult] = useState("");
    const [subscriptionId, setSubscriptionId] = useState("");
    async function read(serverId) {
      setResult("Loading");
      try {
        const client = serverId ? getPaseoClient(serverId) : selected;
        const { subscriptionId } = await client.agents.list({ subscribe: {} });
        setSubscriptionId(subscriptionId);
        const { config } = await client.config.get();
        setResult((serverId || "selected") + ":plugins=" + Boolean(config.pluginsEnabled));
      } catch (error) { setResult(error.message); }
    }
    async function disposeHost(serverId) {
      await getPaseoClient(serverId).dispose();
      setResult("Disposed:" + serverId);
    }
    return <View>
      {hosts.map(host => <View key={host.serverId}>
        <Text>{host.label + ":" + host.status}</Text>
        <Pressable accessibilityRole="button" onPress={() => disposeHost(host.serverId)}><Text>{"Dispose " + host.label}</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => read(host.serverId)}><Text>{"Read " + host.label}</Text></Pressable>
      </View>)}
      <Pressable accessibilityRole="button" onPress={() => read()}><Text>Read selected</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => read("missing")}><Text>Read missing</Text></Pressable>
      <Text>{result}</Text>
      <Text>{"Agents subscription:" + subscriptionId}</Text>
    </View>;
  }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: "Host clients", icon: "Server", surface: "main" });
  return () => {};
}`;

function observeSubscriptionReleases(page: Page, port: number) {
  const released = new Set<string>();
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).port !== String(port)) return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "session" && frame.message?.type === "subscription.release.request")
        released.add(frame.message.subscriptionId);
    });
  });
  return { has: (subscriptionId: string) => released.has(subscriptionId) };
}

export async function openHostClients(page: Page) {
  await page.getByRole("button", { name: "Host clients", exact: true }).click();
}
export async function readHost(page: Page, label: string, result: string) {
  await page.getByRole("button", { name: `Read ${label}`, exact: true }).click();
  await expect(page.getByText(result, { exact: true }).filter({ visible: true })).toBeVisible();
}

export async function installHostClientsScenario(page: Page) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-hosts-"));
  const primary = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const secondary = await startIsolatedHostDaemon("plugin-hosts-secondary");
  const remote = await connectNewWorkspaceDaemonClient({
    port: secondary.port,
    ownProjects: false,
  });
  const previous = await primary.getDaemonConfig();
  const releases = observeSubscriptionReleases(page, secondary.port);
  async function close() {
    await remote.close().catch(() => undefined);
    await secondary.close();
    await primary.removePlugin(id).catch(() => undefined);
    await primary.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await primary.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await remote.patchDaemonConfig({ pluginsEnabled: false });
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), source);
    await primary.patchDaemonConfig({ pluginsEnabled: true });
    await primary.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await openHostClients(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      label: "Secondary",
      port: secondary.port,
      primaryLabel: "Primary",
    });
    await openHostClients(page);
  } catch (error) {
    await close();
    throw error;
  }
  async function expectObservationReleased(action: () => Promise<unknown>) {
    const text = await page
      .getByText(/^Agents subscription:/)
      .filter({ visible: true })
      .innerText();
    const subscriptionId = text.slice("Agents subscription:".length);
    expect(subscriptionId).not.toBe("");
    expect(releases.has(subscriptionId)).toBe(false);
    await action();
    await expect.poll(() => releases.has(subscriptionId)).toBe(true);
  }
  return {
    serverId: secondary.serverId,
    close,
    async expectOnline() {
      await expect(
        page.getByText("Primary:online", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Secondary:online", { exact: true }).filter({ visible: true }),
      ).toBeVisible({ timeout: 30_000 });
    },
    reloadAndExpectObservationReleased: () =>
      expectObservationReleased(() => primary.reloadPlugin(id)),
    async disposeSecondaryAndExpectObservationReleased() {
      await expectObservationReleased(() =>
        page.getByRole("button", { name: "Dispose Secondary", exact: true }).click(),
      );
      await expect(
        page.getByText(`Disposed:${secondary.serverId}`, { exact: true }).filter({ visible: true }),
      ).toBeVisible();
    },
    restartSecondary: () => secondary.restart(),
    async disconnectSecondary() {
      await secondary.close();
      await expect(
        page.getByText(/^Secondary:(offline|error|connecting)$/).filter({ visible: true }),
      ).toBeVisible();
    },
    useCompactLayout: () => page.setViewportSize({ width: 390, height: 844 }),
  };
}
