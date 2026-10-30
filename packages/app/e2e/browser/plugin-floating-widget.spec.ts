import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { openCommandCenter } from "../support/helpers/command-center";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "floating-widget-e2e";
const WIDGET_ID = `plugin-floating-widget:${PLUGIN_ID}:widget`;
const RPC = `const ping = defineRpc({ name: "widget.ping", input: z.object({}), output: z.object({ ready: z.boolean() }) });`;
const SOURCE = `import React, { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { defineRpc } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { z } from "zod";
${RPC}
const chrome = "toolbar";
export default function contribute(client) {
  function Widget({ theme, host, size, DragHandle }) {
    const paseo = usePaseo();
    const rpc = useRpc(ping);
    const [status, setStatus] = useState("Loading context");
    const [activations, setActivations] = useState(0);
    const [longPresses, setLongPresses] = useState(0);
    useEffect(() => {
      let active = true;
      Promise.all([rpc({}), paseo.workspaces.list()]).then(([reply, workspaces]) => {
        if (active) setStatus(reply.ready && Array.isArray(workspaces.entries) ? "Context ready" : "Context invalid");
      }).catch((error) => { if (active) setStatus(String(error)); });
      return () => { active = false; };
    }, [paseo, rpc]);
    return <View testID="floating-fixture-content" pointerEvents="box-none" style={{ width: size.width, height: size.height, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>{status}</Text>
      <Text style={{ color: theme.colors.foreground }} testID="floating-fixture-host">{host.id}</Text>
      {chrome === "none" ? <DragHandle accessibilityLabel="Widget drag target" onPress={() => setActivations(activations + 1)} onLongPress={() => setLongPresses(longPresses + 1)} style={{ width: 120, height: 80 }}>
        <Text style={{ color: theme.colors.foreground }}>{"Widget activations: " + activations}</Text>
        <Text style={{ color: theme.colors.foreground }}>{"Widget long presses: " + longPresses}</Text>
      </DragHandle> : <Button title={"Widget activations: " + activations} onPress={() => setActivations(activations + 1)} />}
      <Button title="Open floating destination" onPress={() => client.openScreen({ screenId: "destination" })} />
    </View>;
  }
  client.addScreen({ id: "destination", title: "Floating destination", Component() {
    return <Text testID="floating-fixture-destination">Destination beneath the floating widget</Text>;
  } });
  client.addFloatingWidget({ chrome, id: "widget", title: "Floating test widget", size: { width: 240, height: 200 }, Component: Widget });
  return () => {};
}`;

test("floats across routes, restores after hiding, and stays within a compact viewport", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-floating-widget-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await Promise.all([
    writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    ),
    writeFile(path.join(directory, "index.client.tsx"), SOURCE),
    writeFile(
      path.join(directory, "index.server.ts"),
      `import { defineRpc } from "@getpaseo/plugin"; import { z } from "zod"; ${RPC} export default function(server) { server.handle(ping, () => ({ ready: true })); return () => {}; }`,
    ),
  ]);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings");
    const widget = page.getByTestId(WIDGET_ID);
    await expect(widget).toBeVisible({ timeout: 30_000 });
    await expect(widget.getByText("Context ready", { exact: true })).toBeVisible();
    await expect(widget.getByTestId("floating-fixture-host")).toHaveText(
      process.env.E2E_SERVER_ID!,
    );
    await widget.getByRole("button", { name: "Widget activations: 0", exact: true }).click();
    await expect(
      widget.getByRole("button", { name: "Widget activations: 1", exact: true }),
    ).toBeVisible();

    const before = await widget.boundingBox();
    expect(before).not.toBeNull();
    const handle = await widget
      .getByRole("button", { name: "Move Floating test widget to next corner" })
      .boundingBox();
    expect(handle).not.toBeNull();
    const dragStart = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
    const dragEnd = { x: dragStart.x - 300, y: dragStart.y - 180 };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await widget.boundingBox())!.x).toBeCloseTo(before!.x - 300, 0);
    await expect.poll(async () => (await widget.boundingBox())!.y).toBeCloseTo(before!.y - 180, 0);
    const dragged = await widget.boundingBox();
    await widget.getByRole("button", { name: "Open floating destination", exact: true }).click();
    await expect(page.getByTestId("floating-fixture-destination")).toBeVisible();
    await expect(
      widget.getByRole("button", { name: "Widget activations: 1", exact: true }),
    ).toBeVisible();
    expect((await widget.boundingBox())!.x).toBeCloseTo(dragged!.x, 0);
    expect((await widget.boundingBox())!.y).toBeCloseTo(dragged!.y, 0);
    await page.screenshot({
      path: testInfo.outputPath("floating-widget-dragged.png"),
      animations: "disabled",
    });

    const moveButton = widget.getByRole("button", {
      name: "Move Floating test widget to next corner",
    });
    await moveButton.focus();
    await moveButton.press("Enter");
    await expect.poll(async () => (await widget.boundingBox())!.x).toBeCloseTo(8, 0);
    await expect.poll(async () => (await widget.boundingBox())!.y).toBeCloseTo(8, 0);
    await moveButton.click();
    await expect
      .poll(async () => (await widget.boundingBox())!.x)
      .toBeCloseTo(1280 - before!.width - 8, 0);
    await expect.poll(async () => (await widget.boundingBox())!.y).toBeCloseTo(8, 0);

    await widget.getByRole("button", { name: "Collapse Floating test widget" }).click();
    await expect(widget.getByTestId("floating-fixture-content")).toHaveCount(0);
    await widget.getByRole("button", { name: "Expand Floating test widget" }).click();
    await expect(widget.getByText("Context ready", { exact: true })).toBeVisible();
    await widget.getByRole("button", { name: "Hide Floating test widget" }).click();
    await expect(widget).toHaveCount(0);
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("Show Floating test widget");
    await commands.getByText("Show Floating test widget", { exact: true }).click();
    await expect(widget).toBeVisible();
    await expect(widget.getByText("Context ready", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 600 });
    await expect(widget).toBeInViewport({ ratio: 1 });
    const compact = await widget.boundingBox();
    expect(compact!.x).toBeGreaterThanOrEqual(0);
    expect(compact!.y).toBeGreaterThanOrEqual(0);
    expect(compact!.x + compact!.width).toBeLessThanOrEqual(390);
    expect(compact!.y + compact!.height).toBeLessThanOrEqual(600);
    await page.screenshot({
      path: testInfo.outputPath("floating-widget-compact.png"),
      animations: "disabled",
    });

    await client.removePlugin(PLUGIN_ID);
    await expect(widget).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    const remainingCommands = await openCommandCenter(page);
    const commandInput = remainingCommands.getByTestId("command-center-input");
    await commandInput.fill("Show Floating test widget");
    await expect(page.getByText("Show Floating test widget", { exact: true })).toHaveCount(0);
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("drags content without chrome while preserving activation, long press, and Command Center recovery", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-floating-body-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await Promise.all([
    writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    ),
    writeFile(
      path.join(directory, "index.client.tsx"),
      SOURCE.replace('const chrome = "toolbar";', 'const chrome = "none";'),
    ),
    writeFile(
      path.join(directory, "index.server.ts"),
      `import { defineRpc } from "@getpaseo/plugin"; import { z } from "zod"; ${RPC} export default function(server) { server.handle(ping, () => ({ ready: true })); return () => {}; }`,
    ),
  ]);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings");
    const widget = page.getByTestId(WIDGET_ID);
    await expect(widget.getByText("Context ready", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(widget.getByRole("button", { name: "Hide Floating test widget" })).toHaveCount(0);
    await expect(widget.getByRole("button", { name: "Collapse Floating test widget" })).toHaveCount(
      0,
    );
    const original = await widget.boundingBox();
    expect(original!.height).toBe(200);
    expect(original!.width).toBe(240);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[data-testid="floating-fixture-content"]') ==
          null,
        { x: original!.x + original!.width - 1, y: original!.y + original!.height - 1 },
      ),
    ).toBe(true);
    const body = widget.getByRole("button", { name: "Widget drag target", exact: true });
    await body.focus();
    await body.press("Enter");
    await expect(widget.getByText("Widget activations: 1", { exact: true })).toBeVisible();
    await body.press("Space");
    await expect(widget.getByText("Widget activations: 2", { exact: true })).toBeVisible();
    await body.click();
    await expect(widget.getByText("Widget activations: 3", { exact: true })).toBeVisible();
    const hold = await body.boundingBox();
    await page.mouse.move(hold!.x + hold!.width / 2, hold!.y + hold!.height / 2);
    await page.mouse.down();
    await expect(widget.getByText("Widget long presses: 1", { exact: true })).toBeVisible();
    await page.mouse.up();
    await expect(widget.getByText("Widget activations: 3", { exact: true })).toBeVisible();
    const handle = await body.boundingBox();
    const dragStart = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x - 260, dragStart.y - 150, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await widget.boundingBox())!.x)
      .toBeCloseTo(original!.x - 260, 0);
    await expect
      .poll(async () => (await widget.boundingBox())!.y)
      .toBeCloseTo(original!.y - 150, 0);
    await expect(widget.getByText("Widget activations: 3", { exact: true })).toBeVisible();
    await expect(widget.getByText("Widget long presses: 1", { exact: true })).toBeVisible();
    const dragged = await widget.boundingBox();
    await widget.getByRole("button", { name: "Open floating destination", exact: true }).click();
    await expect(page.getByTestId("floating-fixture-destination")).toBeVisible();
    expect((await widget.boundingBox())!.x).toBeCloseTo(dragged!.x, 0);
    await expect(widget.getByText("Widget activations: 3", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("floating-widget-frameless-desktop.png"),
      animations: "disabled",
    });
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("Hide Floating test widget");
    await commands.getByText("Hide Floating test widget", { exact: true }).click();
    await expect(widget).toHaveCount(0);
    const restore = await openCommandCenter(page);
    await restore.getByTestId("command-center-input").fill("Show Floating test widget");
    await restore.getByText("Show Floating test widget", { exact: true }).click();
    await expect(widget).toBeVisible();
    const move = await openCommandCenter(page);
    await move.getByTestId("command-center-input").fill("Move Floating test widget to next corner");
    await move.getByText("Move Floating test widget to next corner", { exact: true }).click();
    await expect.poll(async () => (await widget.boundingBox())!.x).toBeLessThan(20);
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(widget).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath("floating-widget-frameless-compact.png"),
      animations: "disabled",
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
