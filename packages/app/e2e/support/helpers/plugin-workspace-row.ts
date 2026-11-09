import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { openCommandCenter } from "./command-center";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";
import { getServerId } from "./server-id";

const PLUGIN_ID = "row-fixture";

/**
 * A large accessory with an opaque Overlay. Setup requests a takeover on `setupWorkspaceId`, if any;
 * commands break and fix the accessory and start, fail and stop takeovers on the open workspace.
 */
function rowFixtureSource(setupWorkspaceId: string | null) {
  return `import React from "react";
import { Pressable, Text, View } from "react-native";

function Accessory({ size, theme }) {
  return <View testID="row-fixture-accessory" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.accent }} />;
}

function BrokenAccessory() {
  throw new Error("Row fixture accessory failed");
}

function Overlay({ data, theme }) {
  if (data === "throw") throw new Error("Row fixture overlay failed");
  return (
    // Tries to take the row's clicks: it asks for pointer events and swallows presses. The host
    // must keep the Overlay out of hit testing so the press still reaches the row.
    <Pressable testID="row-fixture-overlay" onPress={() => {}} style={{ flex: 1, justifyContent: "center", paddingLeft: 48, pointerEvents: "auto", backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color: theme.colors.foreground }}>{"takeover " + data}</Text>
    </Pressable>
  );
}

export default function contribute(client) {
  let removeAccessory = client.addWorkspaceRowAccessory({ id: "fixture", size: "large", Component: Accessory, Overlay });
  const removals = [() => removeAccessory?.()];
  const handles = new Map();
  const play = (workspaceId, data) => {
    const handle = client.requestRowTakeover(workspaceId, { durationMs: 10000, data });
    if (handle) handles.set(workspaceId, handle);
  };
  ${setupWorkspaceId ? `play(${JSON.stringify(setupWorkspaceId)}, "setup");` : ""}
  let removeBroken = null;
  const command = (id, title, onSelect) =>
    removals.push(client.addCommandCenterItem({ id, title, icon: "Play", context: "workspace", onSelect }));
  command("break-accessory", "Row fixture: break accessory", () => {
    removeBroken ??= client.addWorkspaceRowAccessory({ id: "broken", size: "large", Component: BrokenAccessory });
  });
  command("fix-accessory", "Row fixture: fix accessory", () => { removeBroken?.(); removeBroken = null; });
  command("takeover", "Row fixture: takeover", ({ workspace }) => play(workspace.id, "opaque"));
  command("throwing-takeover", "Row fixture: throwing takeover", ({ workspace }) => play(workspace.id, "throw"));
  command("stop-takeover", "Row fixture: stop takeover", ({ workspace }) => handles.get(workspace.id)?.cancel());
  command("remove-accessory", "Row fixture: remove accessory", () => { removeAccessory?.(); removeAccessory = null; });
  return () => { removeBroken?.(); for (const remove of removals) remove(); };
}
`;
}

export async function installRowFixture({
  setupWorkspaceId = null,
}: { setupWorkspaceId?: string | null } = {}) {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-row-fixture-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), rowFixtureSource(setupWorkspaceId));
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return {
    async cleanup() {
      await client.removePlugin(PLUGIN_ID);
      await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function workspaceRow(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

export async function runRowFixtureCommand(page: Page, title: string) {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

/** The opacity the title actually renders with: its own times every ancestor's up to the row. */
export async function titleOpacity(row: Locator, title: string): Promise<number> {
  return row.getByText(title, { exact: true }).evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (node.getAttribute("data-testid")?.startsWith("sidebar-workspace-row-")) break;
    }
    return opacity;
  });
}

/**
 * Whether `target` paints above `cover` where the two overlap; throws if they do not overlap. The
 * host keeps takeover layers `inert`, out of hit testing, so the probe lifts that for its one hit
 * test and puts it back.
 */
export async function paintsAbove(target: Locator, cover: Locator): Promise<boolean> {
  const coverElement = await cover.elementHandle();
  if (!coverElement) throw new Error("cover is not rendered");
  return target.evaluate((element, coverNode) => {
    const own = element.getBoundingClientRect();
    const box = coverNode.getBoundingClientRect();
    const left = Math.max(own.left, box.left);
    const right = Math.min(own.right, box.right);
    const top = Math.max(own.top, box.top);
    const bottom = Math.min(own.bottom, box.bottom);
    if (right <= left || bottom <= top) throw new Error("target and cover do not overlap");
    const shield = coverNode.closest("[inert]");
    shield?.removeAttribute("inert");
    try {
      const painted = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return painted !== null && element.contains(painted);
    } finally {
      shield?.setAttribute("inert", "");
    }
  }, coverElement);
}
