import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { expect } from "@playwright/test";
import { DaemonClient } from "../../client/dist/daemon-client.js";

export function seedWidgetHandoff(paseoHome, rootDir, workspaceRoot) {
  if (process.env.PASEO_DESKTOP_WIDGET_HANDOFF_ONLY !== "1") return;
  const cwd = path.join(workspaceRoot, "workspace-1");
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Widget QA",
      "-c",
      "user.email=widget@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Test fixture",
    ],
    { cwd },
  );
  const file = path.join(paseoHome, "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.plugins["paseo-workflow"] = {
    source: "directory",
    path: path.join(rootDir, "plugins/paseo-workflow"),
    enabled: true,
  };
  fs.writeFileSync(file, JSON.stringify(config));
}

export async function runWidgetHandoff({
  page,
  browser,
  daemonPort,
  serverId,
  workspaceIds,
  cwd,
  artifactDir,
  evaluateMain,
}) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemonPort}/ws`,
    clientId: "widget-handoff-e2e",
    clientType: "cli",
    appVersion: "0.11.1",
    webSocketFactory: (url, options) => new WebSocket(url, options),
  });
  await client.connect();
  try {
    await client.patchDaemonConfig({
      agentProfiles: [
        {
          id: "widget-executor",
          name: "Test executor",
          provider: "mock",
          model: "e2e-fast-stream",
          modeId: "load-test",
        },
      ],
    });
    const source = await client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      modeId: "load-test",
      workspaceId: workspaceIds[0],
      cwd,
      title: "Widget handoff source",
      initialPrompt: "Emit synthetic plan approval.",
    });
    const origin = new URL(page.url()).origin;
    await page.goto(
      `${origin}/h/${serverId}/workspace/${workspaceIds[0]}?open=${encodeURIComponent(`agent:${source.id}`)}`,
    );
    const sourceTab = page.getByTestId(`workspace-tab-agent_${source.id}`).first();
    await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
    await page.screenshot({ path: path.join(artifactDir, "source-before.png") });
    let popup;
    await expect
      .poll(
        async () => {
          for (const context of browser.contexts()) {
            for (const candidate of context.pages()) {
              if (
                candidate !== page &&
                (await candidate.locator('[data-action="handoff"]').count())
              )
                popup = candidate;
            }
          }
          return Boolean(popup);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(popup.locator('[data-action="handoff"]').first()).toBeEnabled({ timeout: 60_000 });
    await popup.screenshot({ path: path.join(artifactDir, "popup-before.png") });
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[1]}`).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceIds[1]}$`));
    const urlBefore = page.url();
    await evaluateMain(
      `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); win.hide(); })()`,
    );
    await popup.locator('[data-action="handoff"]').first().click();
    let executorId;
    await expect
      .poll(
        async () => {
          const status = await client.invokePluginRpc(
            "paseo-workflow",
            "workflow.status.get.request",
            { workspaceId: workspaceIds[0], agentId: source.id },
          );
          executorId = status.handoff?.agentId;
          return Boolean(executorId);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ hostId, workspaceId, sourceId, targetId }) => {
              const persisted = JSON.parse(
                localStorage.getItem("workspace-layout-state") ?? "null",
              );
              const root = JSON.stringify(
                persisted?.state?.layoutByWorkspace?.[`${hostId}:${workspaceId}`]?.root,
              );
              return Boolean(
                root?.includes(`"agentId":"${targetId}"`) &&
                !root.includes(`"agentId":"${sourceId}"`),
              );
            },
            {
              hostId: serverId,
              workspaceId: workspaceIds[0],
              sourceId: source.id,
              targetId: executorId,
            },
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(page.url()).toBe(urlBefore);
    const windowState = await evaluateMain(
      `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); return { visible: win.isVisible(), focused: win.isFocused() }; })()`,
    );
    expect(windowState).toEqual({ visible: false, focused: false });
    await evaluateMain(
      `(() => { const win = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('localhost:')); win.showInactive(); })()`,
    );
    await page.screenshot({ path: path.join(artifactDir, "other-workspace-after.png") });
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[0]}`).click();
    await expect(sourceTab).toHaveCount(0);
    const executorTab = page.getByTestId(`workspace-tab-agent_${executorId}`);
    await expect(executorTab).toHaveCount(1);
    await expect(executorTab).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: path.join(artifactDir, "executor-after.png") });
    const result = {
      sourceId: source.id,
      executorId,
      windowState,
      workspacePreserved: true,
      sourceHistoryPreserved: Boolean(await client.fetchAgent(source.id)),
    };
    fs.writeFileSync(
      path.join(artifactDir, "handoff-result.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    await client.close();
  }
}
