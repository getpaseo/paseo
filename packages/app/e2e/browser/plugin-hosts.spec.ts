import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

const id = "host-clients";
const source = `import { useHosts, getPaseoClient, usePaseo } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
export default function contribute(plugin) {
  function Surface() {
    const hosts = useHosts();
    const selected = usePaseo();
    const [result, setResult] = useState("");
    async function read(serverId) {
      setResult("Loading");
      try {
        const client = serverId ? getPaseoClient(serverId) : selected;
        await client.agents.list({ subscribe: {} });
        const { config } = await client.config.get();
        setResult((serverId || "selected") + ":plugins=" + Boolean(config.pluginsEnabled));
      } catch (error) { setResult(error.message); }
    }
    return <View>
      {hosts.map(host => <View key={host.serverId}>
        <Text>{host.label + ":" + host.status}</Text>
        <Pressable accessibilityRole="button" onPress={() => read(host.serverId)}><Text>{"Read " + host.label}</Text></Pressable>
      </View>)}
      <Pressable accessibilityRole="button" onPress={() => read()}><Text>Read selected</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => read("missing")}><Text>Read missing</Text></Pressable>
      <Text>{result}</Text>
    </View>;
  }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: "Host clients", icon: "Server", surface: "main" });
  return () => {};
}`;

function observeSubscriptionReleases(page: Page, port: number) {
  let count = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).port !== String(port)) return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "session" && frame.message?.type === "subscription.release.request")
        count++;
    });
  });
  return { count: () => count };
}

async function openHostClients(page: Page) {
  await page.getByRole("button", { name: "Host clients", exact: true }).click();
}
async function readHost(page: Page, label: string, result: string) {
  await page.getByRole("button", { name: `Read ${label}`, exact: true }).click();
  await expect(page.getByText(result, { exact: true }).filter({ visible: true })).toBeVisible();
}

test("plugin discovers offline hosts and borrows another host without installing there", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-hosts-"));
  const primary = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const secondary = await startIsolatedHostDaemon("plugin-hosts-secondary");
  const remote = await connectNewWorkspaceDaemonClient({
    port: secondary.port,
    ownProjects: false,
  });
  const previous = await primary.getDaemonConfig();
  const releases = observeSubscriptionReleases(page, secondary.port);
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
    await expect(
      page.getByText("Primary:online", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Secondary:online", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await readHost(page, "selected", "selected:plugins=true");
    await readHost(page, "Secondary", `${secondary.serverId}:plugins=false`);
    await readHost(page, "missing", "Unknown Paseo host: missing");
    const beforeReload = releases.count();
    await primary.reloadPlugin(id);
    await expect.poll(releases.count).toBeGreaterThan(beforeReload);
    await readHost(page, "Secondary", `${secondary.serverId}:plugins=false`);
    await page.screenshot({ path: test.info().outputPath("two-hosts.png") });
    await secondary.restart();
    await expect(
      page.getByText("Secondary:online", { exact: true }).filter({ visible: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await readHost(page, "Secondary", `${secondary.serverId}:plugins=false`);
    await page.setViewportSize({ width: 390, height: 844 });
    await readHost(page, "Secondary", `${secondary.serverId}:plugins=false`);
    await page.screenshot({ path: test.info().outputPath("two-hosts-compact.png") });
    await secondary.close();
    await expect(
      page.getByText(/^Secondary:(offline|error|connecting)$/).filter({ visible: true }),
    ).toBeVisible();
    await readHost(page, "Secondary", `Paseo host is disconnected: ${secondary.serverId}`);
    await readHost(page, "selected", "selected:plugins=true");
  } finally {
    await remote.close().catch(() => undefined);
    await secondary.close();
    await primary.removePlugin(id).catch(() => undefined);
    await primary.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await primary.close();
    await rm(directory, { recursive: true, force: true });
  }
});
