import { createServer } from "node:net";
import { once } from "node:events";
import { agentBrowserEnv } from "../../server/dist/server/server/agent-browser-env.js";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { expect } from "@playwright/test";
import { DaemonClient } from "../../client/dist/daemon-client.js";

export async function runAgentBrowserJourney({
  page,
  daemonPort,
  serverId,
  workspaceIds,
  workspaceRoot,
  artifactDir,
  target,
  paseoHome,
}) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemonPort}/ws`,
    clientId: "agent-browser-e2e",
    clientType: "cli",
    appVersion: "0.11.1",
    webSocketFactory: (url, options) => new WebSocket(url, options),
  });
  await client.connect();
  const environments = [];
  const terminals = [];
  const dashboards = [];
  const selectWorkspace = async (index) => {
    const key = `${serverId}:${workspaceIds[index]}`;
    await page.getByTestId(`sidebar-workspace-row-${key}`).click();
    return page.getByTestId(`workspace-deck-entry-${key}`);
  };
  const visibleGuest = async (scriptToRun) =>
    page.locator("webview").evaluateAll(async (views, expression) => {
      const view = views.find(
        (candidate) => candidate.parentElement?.getAttribute("aria-hidden") === "false",
      );
      if (!view) return null;
      return view.executeJavaScript(expression);
    }, scriptToRun);
  try {
    let deck = await selectWorkspace(0);
    await expect(deck.getByTestId("workspace-browser-toggle")).toBeVisible();
    await expect(deck.getByTestId("workspace-agent-browser-toggle")).toBeVisible();
    const testEnv = agentBrowserEnv(workspaceIds[0], { kind: "agent", id: "dashboard" }, paseoHome);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const conflictPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    execFileSync(
      "agent-browser",
      [
        "dashboard",
        "start",
        "--port",
        String(conflictPort),
        "--allowed-origins",
        "https://qa.example.invalid",
      ],
      { env: { ...process.env, ...testEnv }, timeout: 10_000, stdio: "ignore" },
    );
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    const error = deck.getByTestId("workspace-agent-browser-error");
    await expect(error).toContainText("Couldn’t open Agent browser.");
    await page.screenshot({ path: path.join(artifactDir, "agent-browser-error.png") });
    execFileSync("agent-browser", ["dashboard", "stop"], {
      env: { ...process.env, ...testEnv },
      timeout: 10_000,
      stdio: "ignore",
    });
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(error).toBeHidden();
    // Opening the dashboard alone must leave the workspace without browser sessions.
    await expect
      .poll(() => visibleGuest("document.body.innerText"), { timeout: 20_000 })
      .toContain("Sessions");
    dashboards.push(await client.openWorkspaceAgentBrowser(workspaceIds[0]));
    expect(dashboards[0].error).toBeNull();
    expect(
      await (
        await fetch(`${dashboards[0].url}/api/sessions`, { headers: { Origin: dashboards[0].url } })
      ).json(),
    ).toEqual([]);
    await page.screenshot({ path: path.join(artifactDir, "agent-browser-empty.png") });

    for (let index = 0; index < 2; index++) {
      const envFile = path.join(artifactDir, `agent-browser-env-${index}.json`);
      const resultFile = path.join(artifactDir, `agent-browser-open-${index}.json`);
      const script = `const fs = require('node:fs'); const cp = require('node:child_process'); fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_BROWSER_'))))); try { const output = cp.execFileSync('agent-browser', ['--session', 'shared', 'open', ${JSON.stringify(target.url)}, '--json'], { encoding:'utf8', timeout:30000 }); fs.writeFileSync(${JSON.stringify(resultFile)}, output); } catch(error) { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({error:String(error), stderr:String(error.stderr)})); } setInterval(() => {}, 1000);`;
      const result = await client.createTerminal(
        path.join(workspaceRoot, `workspace-${index + 1}`),
        "Agent browser QA",
        undefined,
        {
          workspaceId: workspaceIds[index],
          command: process.execPath,
          args: ["-e", script],
        },
      );
      expect(result.error).toBeNull();
      terminals.push(result.terminal.id);
      await expect.poll(() => fs.existsSync(resultFile), { timeout: 40_000 }).toBe(true);
      const opened = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      expect(opened.success, JSON.stringify(opened)).toBe(true);
      environments.push(JSON.parse(fs.readFileSync(envFile, "utf8")));
      const dashboard =
        index === 0 ? dashboards[0] : await client.openWorkspaceAgentBrowser(workspaceIds[index]);
      if (index !== 0) dashboards.push(dashboard);
      expect(dashboard.error).toBeNull();
      const sessions = await (
        await fetch(`${dashboard.url}/api/sessions`, { headers: { Origin: dashboard.url } })
      ).json();
      expect(sessions.map((session) => session.session)).toEqual(["shared"]);
    }
    expect(environments[0].AGENT_BROWSER_NAMESPACE).not.toBe(
      environments[1].AGENT_BROWSER_NAMESPACE,
    );
    expect(dashboards[0].url).not.toBe(dashboards[1].url);
    const sessions = await Promise.all(
      dashboards.map(async (dashboard) =>
        (
          await fetch(`${dashboard.url}/api/sessions`, { headers: { Origin: dashboard.url } })
        ).json(),
      ),
    );
    expect(sessions[0][0].port).not.toBe(sessions[1][0].port);

    deck = await selectWorkspace(0);
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await expect
      .poll(() => visibleGuest("document.body.innerText"), { timeout: 20_000 })
      .toContain("Live");
    await page.screenshot({ path: path.join(artifactDir, "agent-browser-session.png") });
    await expect(deck.getByTestId("workspace-browser-toggle")).toHaveAttribute(
      "aria-label",
      "Show browser",
    );
    const before = await page.locator("webview").count();
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    expect(await page.locator("webview").count()).toBe(before);

    await deck.getByTestId("workspace-browser-toggle").click();
    const address = deck.getByRole("textbox", { name: "Address", exact: true });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("webview")].some(
        (view) =>
          view.parentElement?.getAttribute("aria-hidden") === "false" &&
          view.getWebContentsId() > 0 &&
          !view.isLoading(),
      ),
    );
    await address.fill(target.url);
    await address.press("Enter");
    await expect
      .poll(() => visibleGuest("document.title"), { timeout: 20_000 })
      .toBe("Desktop browser target");
    await expect(deck.getByTestId("workspace-browser-toggle")).toHaveAttribute(
      "aria-label",
      "Hide browser",
    );
    await visibleGuest("sessionStorage.setItem('classic-proof', 'kept'); true");
    await page.screenshot({ path: path.join(artifactDir, "agent-browser-classic.png") });
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await deck.getByTestId("workspace-browser-toggle").click();
    await expect.poll(() => visibleGuest("sessionStorage.getItem('classic-proof')")).toBe("kept");
    await deck.getByTestId("workspace-browser-toggle").click();
    await deck.getByTestId("workspace-browser-toggle").click();
    await expect.poll(() => visibleGuest("sessionStorage.getItem('classic-proof')")).toBe("kept");
    await selectWorkspace(1);
    deck = await selectWorkspace(0);
    await expect.poll(() => visibleGuest("sessionStorage.getItem('classic-proof')")).toBe("kept");
    const classicTabId = await deck
      .getByRole("tab", { selected: true })
      .getAttribute("data-testid");
    await deck.getByRole("button", { name: "New browser tab", exact: true }).click();
    await expect(address).toHaveValue("");
    const alternateTabId = await deck
      .getByRole("tab", { selected: true })
      .getAttribute("data-testid");
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await expect(address).toHaveValue(dashboards[0].url + "/");
    const dashboardTabId = await deck
      .getByRole("tab", { selected: true })
      .getAttribute("data-testid");
    await deck.getByTestId(classicTabId).click();
    await expect(address).toHaveValue(target.url);
    await deck.getByTestId(dashboardTabId).click();
    await deck.getByTestId("workspace-browser-toggle").click();
    await expect(address).toHaveValue(target.url);

    await deck.getByTestId(dashboardTabId).click();
    await address.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
    await expect(deck.getByTestId(dashboardTabId)).toHaveCount(0);
    await deck.getByTestId(classicTabId).click();
    await deck.getByTestId(alternateTabId).click();
    await deck.getByRole("button", { name: "All tabs", exact: true }).click();
    await page
      .getByTestId("workspace-browser-reopen-last-closed")
      .filter({ visible: true })
      .click();
    const reopenedTab = deck.getByRole("tab", { selected: true });
    await expect(reopenedTab).toContainText("Agent browser");
    const reopenedTabId = await reopenedTab.getAttribute("data-testid");
    const tabCount = await deck.getByRole("tab").count();
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await expect(deck.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-testid",
      reopenedTabId,
    );
    await expect(deck.getByRole("tab")).toHaveCount(tabCount);
    await deck.getByTestId("workspace-browser-toggle").click();
    await expect(address).toHaveValue("");
    await deck.getByTestId("workspace-agent-browser-toggle").click();
    await expect(deck.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-testid",
      reopenedTabId,
    );
    await page.screenshot({ path: path.join(artifactDir, "agent-browser-reopened.png") });
    fs.writeFileSync(
      path.join(artifactDir, "agent-browser-result.json"),
      JSON.stringify(
        {
          isolatedSessions: true,
          dashboardReused: true,
          classicStatePreserved: true,
          lastClassicPagePreserved: true,
          reopenedDashboardReused: true,
          namespaces: environments.map((env) => env.AGENT_BROWSER_NAMESPACE),
          urls: dashboards.map((value) => value.url),
        },
        null,
        2,
      ),
    );
  } finally {
    for (const env of environments) {
      try {
        execFileSync("agent-browser", ["--session", "shared", "close"], {
          env: { ...process.env, ...env },
          timeout: 10_000,
          stdio: "ignore",
        });
      } catch {}
    }
    for (const id of workspaceIds.slice(0, 2)) {
      const env = agentBrowserEnv(id, { kind: "agent", id: "dashboard" }, paseoHome);
      try {
        execFileSync("agent-browser", ["dashboard", "stop"], {
          env: { ...process.env, ...env },
          timeout: 10_000,
          stdio: "ignore",
        });
      } catch {}
    }
    for (const id of terminals) await client.killTerminal(id).catch(() => {});
    await client.close();
  }
}
