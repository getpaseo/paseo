import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { openCommandCenter } from "./command-center";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

export const SHOWCASE_PLUGIN_ID = "sidebar-showcase";
export const LEGACY_PLUGIN_ID = "legacy-sidebar";
export const BOTS_PLUGIN_ID = "sidebar-bots";
export const WIDE = { width: 1440, height: 900 };
export const COMPACT = { width: 390, height: 844 };

/** A plugin written against the current API: a screen, header and footer items, a command. */
const SHOWCASE_SOURCE = `import React from "react";
import { Pressable, Text, View } from "react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

function DeploysScreen({ theme }) {
  return <View style={{ flex: 1, padding: 24 }}><Text style={{ color: theme.colors.foreground }}>Deploys screen body</Text></View>;
}

function RefreshButton({ theme, onPress }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh deploys" onPress={onPress} style={{ paddingHorizontal: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Refresh</Text>
    </Pressable>
  );
}

function DeploysItem({ theme, currentScreen, openScreen }) {
  const [refreshes, setRefreshes] = React.useState(0);
  return (
    <SidebarRow
      icon="Rocket"
      label={refreshes === 0 ? undefined : "Deploys (refreshed " + refreshes + ")"}
      active={currentScreen?.screenId === "deploys"}
      onPress={() => openScreen({ screenId: "deploys" })}
      trailing={<RefreshButton theme={theme} onPress={() => setRefreshes((count) => count + 1)} />}
    />
  );
}

function SyncDetails({ theme, layout, close, openScreen }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>Sync details</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>Presentation: {layout.compact ? "compact" : "wide"}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Open deploys from popover" onPress={() => openScreen({ screenId: "deploys" })}><Text style={{ color: theme.colors.foreground }}>Open deploys</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close sync details" onPress={close}><Text style={{ color: theme.colors.foreground }}>Done</Text></Pressable>
    </View>
  );
}

function SyncItem({ openPopover }) {
  return <SidebarRow icon="RefreshCw" onPress={() => openPopover(SyncDetails)} />;
}

function Broken() {
  throw new Error("Sidebar item exploded");
}

export default function contribute(client) {
  client.addScreen({ id: "deploys", title: "Deploys", Component: DeploysScreen });
  client.addSidebarHeaderItem({ id: "deploys", title: "Deploys", Component: DeploysItem });
  client.addSidebarHeaderItem({ id: "broken", title: "Broken header", Component: Broken });
  client.addSidebarFooterItem({ id: "sync", title: "Sync", Component: SyncItem });
  client.addSidebarFooterItem({ id: "broken", title: "Broken footer", Component: Broken });
  client.addCommandCenterItem({ id: "open-deploys", title: "Open deploys", icon: "Rocket", context: "global", onSelect: (ctx) => ctx.openScreen({ screenId: "deploys" }) });
  return () => {};
}
`;

/**
 * One header item that renders a group: a row per bot, a separator and a status row. Each bot
 * row opens the bot screen with the bot's id as a param, and its trailing More button opens that
 * bot's popover. Commands open a bot with a `serverId` param, and add and remove a footer item
 * after setup; that item opens an event observation, releases it in its cleanup, and publishes its
 * id on `globalThis.__botAlertsObservation`.
 */
const BOTS_SOURCE = `import React from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";

const BOTS = [
  { id: "bot-1", name: "Bot 1" },
  { id: "bot-2", name: "Bot 2" },
];

function BotScreen({ theme, params }) {
  return (
    <View style={{ flex: 1, padding: 24, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>{"Bot screen: " + params.botId}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{"serverId param: " + (params.serverId ?? "none")}</Text>
    </View>
  );
}

function botTitle(params) {
  return BOTS.find((bot) => bot.id === params.botId)?.name ?? "Bot";
}

const botMenus = {};

function botMenu(bot) {
  botMenus[bot.id] ??= function BotMenu({ theme, close }) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foreground }}>{bot.name + " options"}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={"Close " + bot.name + " options"} onPress={close}><Text style={{ color: theme.colors.foreground }}>Done</Text></Pressable>
      </View>
    );
  };
  return botMenus[bot.id];
}

function MoreButton({ theme, bot, onPress }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={"More for " + bot.name} onPress={onPress} style={{ paddingHorizontal: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>More</Text>
    </Pressable>
  );
}

function BotStatus({ theme, close }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>Bot status details</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Close bot status" onPress={close}><Text style={{ color: theme.colors.foreground }}>Done</Text></Pressable>
    </View>
  );
}

function BotsItem({ theme, currentScreen, openScreen, openPopover }) {
  return (
    <>
      {BOTS.map((bot) => (
        <SidebarRow
          key={bot.id}
          id={bot.id}
          icon="Bot"
          label={bot.name}
          active={currentScreen?.screenId === "bot" && currentScreen.params.botId === bot.id}
          onPress={() => openScreen({ screenId: "bot", params: { botId: bot.id } })}
          trailing={<MoreButton theme={theme} bot={bot} onPress={() => openPopover(botMenu(bot))} />}
        />
      ))}
      <SidebarSeparator />
      <SidebarRow id="status" icon="Activity" label="Bot status" onPress={() => openPopover(BotStatus)} />
    </>
  );
}

function AlertsItem() {
  const paseo = usePaseo();
  React.useEffect(() => {
    const observation = paseo.observeEvents(["project.update"]);
    observation.subscribe({ snapshot(value) { globalThis.__botAlertsObservation = value.subscriptionId; }, update() {} });
    return () => { void observation.release(); };
  }, [paseo]);
  return <SidebarRow icon="Bell" onPress={() => {}} />;
}

export default function contribute(client) {
  let removeAlerts = null;
  client.addScreen({ id: "bot", title: botTitle, Component: BotScreen });
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: BotsItem });
  client.addCommandCenterItem({ id: "open-bot-3", title: "Open bot 3 on server x", icon: "Bot", context: "global", onSelect: (ctx) => ctx.openScreen({ screenId: "bot", params: { botId: "bot-3", serverId: "x" } }) });
  client.addCommandCenterItem({ id: "add-alerts", title: "Add bot alerts", icon: "Bell", context: "global", onSelect: () => {
    if (!removeAlerts) removeAlerts = client.addSidebarFooterItem({ id: "alerts", title: "Bot alerts", Component: AlertsItem });
  } });
  client.addCommandCenterItem({ id: "remove-alerts", title: "Remove bot alerts", icon: "BellOff", context: "global", onSelect: () => {
    removeAlerts?.();
    removeAlerts = null;
  } });
  return () => {};
}
`;

/** A plugin that still uses only the old descriptor calls. */
const LEGACY_SOURCE = `import React from "react";
import { Text, View } from "react-native";

function Main({ theme }) {
  return <View style={{ flex: 1, padding: 24 }}><Text style={{ color: theme.colors.foreground }}>Legacy screen body</Text></View>;
}

export default function contribute(plugin) {
  plugin.addSurface("main", Main);
  plugin.addSidebarItem({ id: "entry", title: "Legacy entry", icon: "Server", surface: "main" });
  plugin.addSidebarItem({ id: "hidden", title: "Legacy hidden", icon: "Blocks", surface: "main" });
  return () => {};
}
`;

export async function installSidebarPlugins() {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directories: string[] = [];
  for (const [id, source] of [
    [SHOWCASE_PLUGIN_ID, SHOWCASE_SOURCE],
    [LEGACY_PLUGIN_ID, LEGACY_SOURCE],
    [BOTS_PLUGIN_ID, BOTS_SOURCE],
  ] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `paseo-${id}-`));
    directories.push(directory);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), source);
  }
  await client.patchDaemonConfig({ pluginsEnabled: true });
  for (const directory of directories) await client.installDirectoryPlugin(directory);
  return {
    async cleanup() {
      await client.removePlugin(SHOWCASE_PLUGIN_ID);
      await client.removePlugin(LEGACY_PLUGIN_ID);
      await client.removePlugin(BOTS_PLUGIN_ID);
      await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
      await client.close();
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    },
  };
}

/** The first visible match: the shell keeps a compact copy of the sidebar mounted. */
export function visibleTestId(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`).first();
}

export function headerRow(page: Page, pluginId: string, itemId: string): Locator {
  return visibleTestId(page, `plugin-sidebar-${pluginId}-${itemId}`);
}

export function footerItem(page: Page, pluginId: string, itemId: string): Locator {
  return visibleTestId(page, `plugin-sidebar-footer-${pluginId}-${itemId}`);
}

export async function expectRowActive(row: Locator, active: boolean): Promise<void> {
  if (active) await expect(row).toHaveAttribute("aria-selected", "true");
  else await expect(row).not.toHaveAttribute("aria-selected", "true");
}

export async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

export async function closeScreen(page: Page): Promise<void> {
  await page.getByTestId("plugin-surface-close").click();
  await expect(page).not.toHaveURL(/\/plugin\//);
}

/** Box of the popover body, located from the text it renders. */
export async function popoverBox(page: Page, text = "Sync details") {
  const details = page.getByText(text, { exact: true });
  await expect(details).toBeInViewport();
  const box = await details.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
