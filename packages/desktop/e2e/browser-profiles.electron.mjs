import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect } from "@playwright/test";

export function accountFixture(requestCookie) {
  return `<!doctype html><meta charset=utf-8><title>Account fixture</title>
    <style>body{font:20px system-ui;margin:3rem;color:#17334e}h1{font-size:38px}button,a{font:inherit;padding:8px}</style>
    <p>Account fixture</p><h1 id="account"></h1><button>Alice</button> <button>Bob</button>
    <p><a href="/profile-account?link" target="_blank" rel="noopener">Open in another tab</a></p>
    <script>const account = document.querySelector("#account");
    const show = () => (account.textContent = localStorage.getItem("account") || "Signed out");
    window.firstCookie = ${JSON.stringify(requestCookie).replaceAll("<", "\\u003c")};
    for (const button of document.querySelectorAll("button")) button.onclick = () => {
      const name = button.textContent; document.cookie = "account=" + name + "; Path=/; Max-Age=86400; SameSite=Lax";
      localStorage.setItem("account", name); show();
    }; show();</script>`;
}

// The first document is held until browser_new_tab has returned and listed the tab.
async function checkDelayedRegistration(tool) {
  const before = new Set((await tool("browser_list_tabs", {})).tabs.map((tab) => tab.browserId));
  let requestAt, responseAt, release;
  const held = new Promise((resolve) => (release = resolve));
  const server = createServer((request, response) => {
    if (request.url !== "/slow") {
      response.writeHead(404).end();
      return;
    }
    requestAt = Date.now();
    void (async () => {
      await held;
      responseAt = Date.now();
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<title>Slow fixture</title><p>Slow page loaded</p>");
    })();
  });
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${server.address().port}/slow`;
  const newIds = async () =>
    (await tool("browser_list_tabs", {})).tabs
      .map((tab) => tab.browserId)
      .filter((id) => !before.has(id));
  const start = Date.now();
  try {
    const { browserId } = await tool("browser_new_tab", { url });
    const returnedAt = Date.now();
    const pending = await newIds();
    expect(pending).toEqual([browserId]);
    expect(responseAt).toBeUndefined();
    release();
    await tool("browser_wait", { browserId, text: "Slow page loaded", timeoutMs: 15000 });
    const loaded = await newIds();
    expect(loaded).toEqual([browserId]);
    return {
      browserId,
      requestedMs: requestAt - start,
      returnedMs: returnedAt - start,
      respondedMs: responseAt - start,
      pending,
      loaded,
    };
  } finally {
    release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runProfileJourney({
  page,
  inspect,
  openWorkspace,
  artifactDir,
  url,
  workspaceIds,
  serverId,
  tool,
  restart,
}) {
  const project = "Desktop browser project 1";
  const automatic = project + " › Desktop browser workspace 1";
  const shared = "Shared › Work";
  const named = project + " › Customer";
  const picker = () => page.locator('[data-testid="browser-profile-picker"]:visible');
  const label = () => page.locator('[data-testid="browser-profile-label"]:visible');
  const menuGroup = (name) =>
    page.locator('[data-menu-surface="true"]:visible').getByRole("group", { name, exact: true });
  const address = () => page.getByRole("textbox", { name: "Browser URL" });
  const tab = (id) => page.getByTestId("workspace-tab-browser_" + id);
  const focus = async (id) => {
    await tab(id).click();
    await expect(page.getByTestId("browser-webview-clip-" + id)).toBeVisible();
  };
  const active = () => page.locator('[data-paseo-browser-surface][aria-hidden="false"] webview');
  const activeId = () => active().getAttribute("data-paseo-browser-id");
  const guest = (id, expression) =>
    page
      .locator(`webview[data-paseo-browser-id="${id}"]`)
      .evaluate((view, code) => view.executeJavaScript(code, true), expression);
  const evidence = { before: [], after: [], groups: [] };
  const save = () =>
    fs.writeFileSync(path.join(artifactDir, "profiles.json"), JSON.stringify(evidence, null, 2));
  // Evidence only: let the page and the visible guest paint, then capture the window.
  const screenshot = async (name) => {
    const frames = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";
    await page.evaluate(frames);
    await active()
      .evaluate((view, code) => view.executeJavaScript(code, true), frames)
      .catch(() => undefined);
    const png = await inspect(
      "return win.capturePage().then(image => image.toPNG().toString('base64'));",
    );
    fs.writeFileSync(path.join(artifactDir, name + ".png"), Buffer.from(png, "base64"));
  };
  async function blank() {
    const launcher = page.locator('[data-testid="workspace-new-tab-browser"]:visible').first();
    if (await launcher.isVisible()) await launcher.click();
    else {
      await page.locator('[data-testid="workspace-new-tab-button"]:visible').first().click();
      await page.getByTestId("workspace-new-tab-menu-browser").click();
    }
    await expect(picker()).toBeVisible({ timeout: 15000 });
    await expect(address()).toHaveValue("");
    expect(await active().evaluate((view) => view.getURL())).toBe("about:blank");
    return activeId();
  }
  async function choose(name) {
    await picker().click();
    const row = page.getByText(name, { exact: true }).last();
    await row.click();
    await expect(picker()).toContainText(name);
  }
  async function create(group, name, caption) {
    await picker().click();
    const action = menuGroup(group).getByText(
      group === "Shared" ? "Create new shared profile…" : "Create new project profile…",
      { exact: true },
    );
    await action.first().click();
    await page.getByTestId("browser-create-profile-input").fill(name);
    await page.getByTestId("browser-create-profile-submit").click();
    await expect(picker()).toContainText(caption);
  }
  async function go(destination) {
    await address().fill(destination);
    await address().press("Enter");
  }
  async function verify(id, caption, account, stage) {
    await focus(id);
    await expect(label()).toHaveText(caption);
    await expect(picker()).toHaveCount(0);
    const values = await guest(
      id,
      "({ account: document.querySelector('#account')?.textContent, cookie: document.cookie, storage: localStorage.getItem('account'), url: location.href, firstCookie: window.firstCookie })",
    );
    expect(values).toMatchObject({
      account,
      cookie: "account=" + account,
      storage: account,
      url,
      firstCookie: stage === "after" ? "account=" + account : "",
    });
    const name = stage + "-" + account.toLowerCase();
    await screenshot(name);
    evidence[stage].push({ id, label: caption, ...values, screenshot: name + ".png" });
    save();
  }
  const workspace = (i) => openWorkspace(page, serverId + ":" + workspaceIds[i]);
  try {
    await inspect(`global.profileExampleRequests = []; process.mainModule.require('electron').app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') contents.on('did-start-navigation', event => {
        if (event.isMainFrame && new URL(event.url).hostname === 'example.com') global.profileExampleRequests.push(event.url);
      }); }); return true;`);
    await workspace(0);
    const alice = await blank();
    await expect(picker()).toContainText(automatic);
    await picker().click();
    await expect(page.getByText("Shared", { exact: true })).toBeVisible();
    await expect(page.getByText("default", { exact: true })).toBeVisible();
    await menuGroup("Shared").evaluate(async (group) => {
      for (let node = group; node; node = node.parentElement) {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      }
    });
    await screenshot("pristine-menu");
    await menuGroup(project).getByText("Create new project profile…", { exact: true }).click();
    await page.getByTestId("browser-create-profile-input").fill("Desktop browser workspace 1");
    await page.getByTestId("browser-create-profile-submit").click();
    const duplicate = page.getByTestId("browser-create-profile-error");
    await expect(duplicate).toHaveText("A profile with this name already exists in this group.");
    evidence.duplicate = { error: await duplicate.innerText(), automatic };
    await screenshot("duplicate-rejected");
    await page.getByTestId("browser-create-profile-cancel").click();
    await expect(picker()).toContainText(automatic);
    await picker().click();
    await expect(
      menuGroup(project).getByText("Desktop browser workspace 1", { exact: true }),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");
    await create("Shared", "Work", shared);
    await go(url);
    await expect(label()).toHaveText(shared);
    await guest(alice, "document.querySelector('button').click()");
    const bob = await blank();
    await create(project, "Customer", named);
    await go(url);
    await expect(label()).toHaveText(named);
    await guest(bob, "document.querySelectorAll('button')[1].click()");
    await verify(alice, shared, "Alice", "before");
    await verify(bob, named, "Bob", "before");

    evidence.delayedRegistration = await checkDelayedRegistration(tool);
    save();

    // Use the same first-request fixture to distinguish workspace and opener sessions.
    const agent = await tool("browser_new_tab", {});
    expect(agent.url).toBe("about:blank");
    await focus(agent.browserId);
    await expect(picker()).toContainText(automatic);
    await focus(bob);
    await tool("browser_navigate", { browserId: agent.browserId, url });
    await focus(agent.browserId);
    await expect(label()).toHaveText(automatic);
    expect(await guest(agent.browserId, "window.firstCookie")).toBe("");
    await guest(
      agent.browserId,
      'document.cookie = "account=Workspace; Path=/; Max-Age=86400"; localStorage.setItem("account", "Workspace")',
    );
    const direct = await tool("browser_new_tab", { url });
    await focus(direct.browserId);
    await expect(label()).toHaveText(automatic);
    expect(await guest(direct.browserId, "window.firstCookie")).toBe("account=Workspace");
    await focus(alice);
    await guest(alice, "document.querySelector('a').click()");
    await expect(label()).toHaveText(automatic);
    expect(await guest(await activeId(), "window.firstCookie")).toBe("account=Workspace");
    evidence.defaults = {
      parked: agent.browserId,
      supplied: direct.browserId,
      link: await activeId(),
      firstRequest: "account=Workspace",
    };
    for (const i of [1, 2]) {
      await workspace(i);
      await blank();
      await picker().click();
      await expect(menuGroup("Shared").getByText("Work", { exact: true })).toBeVisible();
      const currentProject = i === 1 ? project : "Desktop browser project 3";
      const groupLabels = await page
        .locator('[data-menu-surface="true"]:visible [role="group"]')
        .evaluateAll((groups) => groups.map((row) => row.getAttribute("aria-label")));
      expect(groupLabels).toEqual(["Shared", currentProject]);
      await expect(menuGroup(currentProject).getByText("Customer", { exact: true })).toHaveCount(
        i === 1 ? 1 : 0,
      );
      await expect(page.locator('[aria-checked="true"]:visible')).toContainText(
        "Desktop browser workspace " + (i + 1),
      );
      evidence.groups.push({
        workspace: workspaceIds[i],
        selected: await picker().getAttribute("aria-label"),
        shared: await menuGroup("Shared").innerText(),
        groupLabels,
        project: await menuGroup(currentProject).innerText(),
        checked: await page.locator('[aria-checked="true"]:visible').innerText(),
      });
      await page.keyboard.press("Escape");
    }
    await workspace(1);
    await page.getByRole("button", { name: "Plugin links QA", exact: true }).click();
    await page.getByRole("button", { name: "Open workspace browser", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/workspace/" + workspaceIds[0]));
    await expect(label()).toHaveText(automatic);
    expect(await guest(await activeId(), "window.firstCookie")).toBe("account=Workspace");
    evidence.defaults.plugin = {
      id: await activeId(),
      label: automatic,
      firstRequest: "account=Workspace",
    };
    const untouched = await blank();
    await choose("Work");
    await expect(picker()).toContainText(shared);
    const revisited = await blank();
    await choose("Customer");
    await go(url);
    await expect(label()).toHaveText(named);
    expect(await guest(revisited, "window.firstCookie")).toBe("account=Bob");
    await label().click();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Create new shared profile…", { exact: true })).toHaveCount(0);
    await go("about:blank");
    await expect.poll(() => guest(revisited, "location.href")).toBe("about:blank");
    await expect(label()).toHaveText(named);
    // The automatic profile has saved data but no live guest after the relaunch.
    const dormantPartition = await page
      .locator(`webview[data-paseo-browser-id="${direct.browserId}"]`)
      .getAttribute("partition");
    expect(await inspect("return global.profileExampleRequests")).toEqual([]);
    evidence.defaults.exampleRequests = [];
    const firstPid = await inspect("return process.pid;");
    page = await restart();
    const secondPid = await inspect("return process.pid;");
    expect(secondPid).not.toBe(firstPid);
    evidence.processes = [firstPid, secondPid];
    await workspace(0);
    await verify(alice, shared, "Alice", "after");
    await verify(bob, named, "Bob", "after");
    await focus(revisited);
    await expect(label()).toHaveText(named);
    expect(await guest(revisited, "location.href")).toBe("about:blank");
    await focus(untouched);
    await expect(picker()).toContainText(shared);
    evidence.restored = { revisited, untouched };
    save();

    // Clear on this launch: Work and Customer are live, the automatic profile is only on disk.
    const live = await inspect(
      "return process.mainModule.require('electron').webContents.getAllWebContents().filter(c => c.getType() === 'webview').map(c => c.session.storagePath);",
    );
    expect(live.some((dir) => path.basename(dir) === dormantPartition.slice(8))).toBe(false);
    expect(live.some((dir) => path.basename(dir) === "paseo-shared-work")).toBe(true);
    await inspect(
      `return process.mainModule.require('electron').session.fromPartition('persist:unrelated-sentinel').cookies.set({url:${JSON.stringify(url)}, name:"sentinel", value:"retained"});`,
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator('[data-testid="settings-sidebar"]:visible')
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await inspect(`const {dialog} = process.mainModule.require('electron'); const show = dialog.showMessageBox; dialog.showMessageBox = async (owner, options) => {
      dialog.showMessageBox = show;
      if (options.title !== 'Clear browser data?') throw new Error('Unexpected confirmation');
      return { response: options.buttons.indexOf('Clear browser data'), checkboxChecked:false };
    }; return true;`);
    await page.getByRole("button", { name: "Clear browser data", exact: true }).click();
    await expect(page.getByText("Browser data cleared.", { exact: true })).toBeVisible();
    await page.getByTestId("settings-back-to-workspace").click();
    await focus(alice);
    await expect(label()).toHaveText(shared);
    const cleared = "({cookie: document.cookie, storage: localStorage.getItem('account')})";
    expect(await guest(alice, cleared)).toEqual({ cookie: "", storage: null });
    await focus(bob);
    await expect(label()).toHaveText(named);
    expect(await guest(bob, cleared)).toEqual({ cookie: "", storage: null });
    await screenshot("cleared-customer");
    await focus(direct.browserId);
    await expect(label()).toHaveText(automatic);
    expect(await guest(direct.browserId, cleared)).toEqual({ cookie: "", storage: null });
    await blank();
    await picker().click();
    await expect(menuGroup("Shared").getByText("Work", { exact: true })).toBeVisible();
    await expect(menuGroup(project).getByText("Customer", { exact: true })).toBeVisible();
    expect(
      await inspect(
        "return process.mainModule.require('electron').session.fromPartition('persist:unrelated-sentinel').cookies.get({name:'sentinel'}).then(rows => rows[0]?.value);",
      ),
    ).toBe("retained");
    evidence.clear = {
      open: [alice, bob],
      closed: direct.browserId,
      closedPartition: dormantPartition,
      liveBefore: live.map((dir) => path.basename(dir)),
      openLabel: shared,
      reopenedLabel: named,
      cookie: "",
      storage: null,
      unrelated: "retained",
    };
    save();
    return evidence;
  } catch (error) {
    await screenshot("profile-failure").catch(() => undefined);
    fs.writeFileSync(
      path.join(artifactDir, "profile-failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw error;
  }
}
