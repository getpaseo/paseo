// Run after npm run build:main --workspace=@getpaseo/desktop.
import { _electron as electron, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../test-results/agent-widget");
await mkdir(output, { recursive: true });
const previousBundleId =
  process.platform === "darwin"
    ? execFileSync("osascript", [
        "-e",
        'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
      ])
        .toString()
        .trim()
    : null;
const home = await mkdtemp(path.join(os.tmpdir(), "paseo-widget-"));
const app = await electron.launch({
  args: [path.join(here, "fixtures/agent-widget.cjs")],
  env: { ...process.env, PASEO_WIDGET_TEST_HOME: home },
});
const labels = {
  plan: "Plan prêt",
  question: "Réponse attendue",
  execute: "Exécuter",
  comment: "Ajouter une consigne…",
  sendComment: "Envoyer",
  handoff: "Handoff",
  noProfiles: "Aucun profil disponible",
  submit: "Envoyer la réponse",
  next: "Suivant",
  close: "Fermer",
  minimize: "Réduire",
  pending: "Envoi…",
  sent: "Réponse envoyée",
  offline: "Hôte déconnecté",
  failed: "Erreur",
};
const plan = {
  key: JSON.stringify(["host", "agent", "plan"]),
  serverId: "host",
  agentId: "agent",
  requestId: "plan",
  workspaceId: "workspace",
  workspaceTitle: "Popup de plans",
  planCallId: "plan-call",
  handoffProfiles: [
    { id: "profile-1", name: "Codex rapide" },
    { id: "profile-2", name: "Claude architecture" },
    { id: "profile-3", name: "Codex approfondi" },
    { id: "profile-4", name: "Revue en lecture seule" },
  ],
  planText: "# Plan fictif — test automatique\n\nAfficher le premier contenu de test.",
  project: {
    name: "Atlas",
    branchName: "feat/widget-header",
    color: "#3d7ea6",
    iconDataUri: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><rect width="30" height="30" rx="5" fill="#304c75"/><path d="M5 23 15 6l10 17h-6l-4-7-4 7Z" fill="#fff"/></svg>').toString("base64")}`,
  },
  agentTitle: "TEST — Codex",
  workspace: "Environnement de test",
  title: "Plan fictif — test automatique",
  kind: "plan",
  canApprove: true,
  questions: [],
  planHtml: "<h1>Plan fictif — test automatique</h1><p>Afficher le premier contenu de test.</p>",
};
const question = {
  ...plan,
  key: JSON.stringify(["host", "agent2", "question"]),
  agentId: "agent2",
  requestId: "question",
  agentTitle: "TEST — Claude",
  kind: "question",
  planHtml: "",
  questions: [
    {
      header: "Moment",
      question: "Quand le widget doit-il apparaître ?",
      options: [
        { label: "À chaque demande", description: "Plans prêts et questions." },
        { label: "Si Paseo est masqué", description: "Quand vous travaillez ailleurs." },
      ],
      multiSelect: false,
      allowOther: true,
      allowEmpty: false,
    },
    {
      header: "Contenu",
      question: "Que souhaitez-vous voir ?",
      options: [{ label: "Le projet" }, { label: "Les étapes" }],
      multiSelect: true,
      allowOther: false,
      allowEmpty: false,
    },
    {
      header: "Contrainte",
      question: "Une contrainte supplémentaire ?",
      options: [],
      multiSelect: false,
      allowOther: false,
      allowEmpty: true,
    },
  ],
};
try {
  const owner = await app.firstWindow();
  await owner.waitForFunction(() => Boolean(window.paseoDesktop?.agentWidget));
  await owner.evaluate(() => {
    window.widgetActions = [];
    window.widgetError = "La réponse n’a pas pu être envoyée. Réessayez.";
    window.paseoDesktop.agentWidget.onAction((delivery) => {
      window.widgetActions.push(delivery.action);
      void window.paseoDesktop.agentWidget.result({
        operationId: delivery.operationId,
        error: window.widgetError,
      });
    });
  });
  const opened = app.waitForEvent("window");
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  const widget = await opened;
  const errors = [];
  widget.on("pageerror", (error) => errors.push(error.message));
  await expect(widget.locator("#comment")).toBeVisible();
  await expect(widget.locator(".identity b")).toHaveText("Atlas");
  await expect(widget.locator(".identity small")).toHaveText("Popup de plans");
  await expect(widget.locator("header")).not.toContainText(/paseo/i);
  await expect(widget.locator(".avatar img")).toHaveJSProperty("naturalWidth", 30);
  await widget.locator("header").screenshot({ path: path.join(output, "header-logo.png") });
  for (const [suffix, project, expected] of [
    ["emoji", { ...plan.project, emoji: "🚀" }, "🚀"],
    ["initial", { ...plan.project, iconDataUri: undefined }, "A"],
  ]) {
    await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
      serverId: "host",
      online: true,
      requests: [{ ...plan, project }, question],
      labels,
    });
    await expect(widget.locator(".avatar")).toHaveText(expected);
    await widget.locator("header").screenshot({ path: path.join(output, `header-${suffix}.png`) });
  }
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator(".markdown h1")).toHaveText("Plan fictif — test automatique");
  const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Paseo");
    return {
      bounds: win.getBounds(),
      area: screen.getPrimaryDisplay().workArea,
      focused: win.isFocused(),
      top: win.isAlwaysOnTop(),
      ownersVisible: BrowserWindow.getAllWindows().some(
        (candidate) => candidate !== win && candidate.isVisible(),
      ),
    };
  });
  expect(geometry.top).toBe(true);
  expect(geometry.focused).toBe(false);
  expect(geometry.ownersVisible).toBe(true);
  expect(geometry.bounds.x + geometry.bounds.width).toBe(
    geometry.area.x + geometry.area.width - 16,
  );
  expect(geometry.bounds.height).toBeLessThan(geometry.area.height - 32);
  expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.area.y);
  expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(
    geometry.area.y + geometry.area.height,
  );
  const comment = widget.locator("#comment");
  expect(await comment.evaluate((element) => element.tagName)).toBe("TEXTAREA");
  expect(await comment.evaluate((element) => element.offsetHeight)).toBe(34);
  const multiline = Array.from({ length: 20 }, (_, i) => `Consigne ${i + 1}`).join("\n");
  await comment.fill(multiline);
  await expect.poll(() => comment.evaluate((element) => element.offsetHeight)).toBe(140);
  expect(await comment.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await widget.screenshot({ path: path.join(output, "plan-multiline.png") });
  await comment.fill("Deux lignes\nConsigne à conserver");
  await comment.evaluate((element) => {
    element.focus();
    element.setSelectionRange(3, 10, "backward");
  });
  const renamed = { ...plan, workspaceTitle: "Popup renommée — " + "titre long ".repeat(20) };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [renamed, question],
    labels,
  });
  await expect(widget.locator(".identity small")).toHaveText(renamed.workspaceTitle);
  await expect(comment).toHaveValue("Deux lignes\nConsigne à conserver");
  expect(
    await comment.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual([3, 10, "backward"]);
  await widget.screenshot({ path: path.join(output, "plan-renamed.png") });
  await comment.fill("");
  await expect.poll(() => comment.evaluate((element) => element.offsetHeight)).toBe(34);
  await comment.press("Enter");
  await expect(comment).toHaveValue("\n");
  expect(await owner.evaluate(() => window.widgetActions)).toEqual([]);
  await comment.fill("");
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator(".identity small")).toHaveText(plan.workspaceTitle);
  await widget.screenshot({ path: path.join(output, "plan-short.png") });
  // The identity is the current drag handle; only the dedicated button reduces.
  expect(
    await widget.locator("header").evaluate((element) => getComputedStyle(element).webkitAppRegion),
  ).toBe("drag");
  for (const selector of [".identity b", ".avatar"]) {
    await widget.locator(selector).click();
    await expect(widget.locator("#comment")).toBeVisible();
    await expect(widget.locator(".pill")).toHaveCount(0);
  }
  await widget.locator('[data-action="reduce"]').click();
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("header button").focus();
  await widget.locator("header button").press("Space");
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").press("Enter");
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("#comment").fill("Garde le widget silencieux.");
  const activationBeforeAction = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (candidate) => candidate.getTitle() !== "Paseo" && candidate.isFocused(),
    ),
  );
  await expect(widget.locator(".handoff-row button")).toHaveText(
    plan.handoffProfiles.map((profile) => profile.name),
  );
  const buttonRows = await widget
    .locator(".handoff-row button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(buttonRows).size).toBeGreaterThan(1);
  await widget.screenshot({ path: path.join(output, "plan.png") });
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [question],
    labels,
  });
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator(".question-title")).toContainText("Quand");
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [],
    labels,
  });
  await expect(widget.locator(".pill")).toHaveText(/Paseo.*0/);
  // Transparent pill captures can stall in both CDP and capturePage after resize.
  // Its contents and geometry are asserted; retain screenshots of the full window.
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator(".pill")).toBeVisible();
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  const simultaneousPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "simultaneous"]),
    requestId: "simultaneous",
  };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [simultaneousPlan, question],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("#comment").fill("Garde le widget silencieux.");
  const replacement = {
    ...plan,
    planText: "# Second plan fictif — test automatique\n\nAfficher le second contenu de test.",
    planHtml:
      "<h1>Second plan fictif — test automatique</h1><p>Afficher le second contenu de test.</p>",
  };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [replacement, question],
    labels,
  });
  await expect(widget.locator(".markdown h1")).toHaveText("Second plan fictif — test automatique");
  await expect(widget.locator(".markdown")).not.toContainText(
    "Afficher le premier contenu de test.",
  );
  await widget.screenshot({ path: path.join(output, "plan-replaced.png") });
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator(".markdown h1")).toHaveText("Plan fictif — test automatique");
  await widget.locator("#send-comment").click();
  const activationAfterAction = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (candidate) => candidate.getTitle() !== "Paseo" && candidate.isFocused(),
    ),
  );
  expect(activationAfterAction).toEqual(activationBeforeAction);
  await expect(widget.locator(".notice.error")).toContainText("Réessayez");
  await expect(widget.locator("#comment")).toHaveValue("Garde le widget silencieux.");
  await widget.screenshot({ path: path.join(output, "error.png") });
  await widget.locator("[data-action=next]").click();
  await expect(widget.locator(".question-title")).toContainText("Quand");
  await widget.screenshot({ path: path.join(output, "question.png") });
  await widget.locator("#answer").press("Enter");
  await expect(widget.locator(".question-title")).toContainText("Quand");
  await widget.locator("#answer").fill("Après validation.");
  await widget.locator("#answer").press("Enter");
  await expect(widget.locator(".question-title")).toContainText("Que souhaitez-vous voir");
  await widget.locator("input[name=option]").nth(0).check();
  await widget.locator("input[name=option]").nth(1).check();
  await widget.screenshot({ path: path.join(output, "multiple.png") });
  await widget.locator("[data-action=question-next]").click();
  await expect(widget.locator("[data-action=answer]")).toBeEnabled();
  await widget.locator("#answer").fill("Ne pas interrompre la saisie.");
  await widget.locator("#answer").press("End");
  await widget.locator("#answer").press("Shift+Enter");
  await expect(widget.locator("#answer")).toHaveValue("Ne pas interrompre la saisie.\n");
  await widget.locator("#answer").dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await expect(widget.locator("#answer")).toBeEnabled();
  await widget.screenshot({ path: path.join(output, "free.png") });
  await owner.evaluate(() => (window.widgetError = null));
  await widget.locator("#answer").press("Enter");
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.screenshot({ path: path.join(output, "reduced-after-answer.png") });
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator("#comment")).toHaveValue("Garde le widget silencieux.");
  const mainRouteBeforeHandoff = owner.url();
  if (previousBundleId)
    execFileSync("osascript", ["-e", `tell application id "${previousBundleId}" to activate`]);
  const frontmost = () =>
    process.platform === "darwin"
      ? execFileSync("osascript", [
          "-e",
          'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
        ])
          .toString()
          .trim()
      : null;
  const applicationBeforeHandoff = frontmost();
  const mainFocusBeforeHandoff = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => win.getTitle() !== "Paseo" && win.isFocused()),
  );
  await widget.locator('[data-action="handoff"]').first().click();
  await expect(widget.locator(".pill")).toBeVisible();
  expect(frontmost()).toBe(applicationBeforeHandoff);
  expect(owner.url()).toBe(mainRouteBeforeHandoff);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => win.getTitle() !== "Paseo" && win.isFocused()),
    ),
  ).toBe(mainFocusBeforeHandoff);
  const actions = await owner.evaluate(() => window.widgetActions);
  expect(actions.map((action) => action.type)).toEqual(["comment", "answer", "handoff"]);
  expect(actions.at(-1).profileId).toBe("profile-1");
  expect(actions[2]).toMatchObject({ planCallId: "plan-call", planText: plan.planText });
  expect(actions[1].selections).toEqual([[], [0, 1], []]);
  expect(actions[1].texts).toEqual(["Après validation.", "", "Ne pas interrompre la saisie.\n"]);
  // A lagging owner snapshot cannot resurrect a handled request.
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect(widget.locator(".pill")).toHaveText(/Paseo.*0/);
  const newPlan = { ...plan, key: JSON.stringify(["host", "agent", "plan2"]), requestId: "plan2" };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: false,
    requests: [newPlan],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await expect(widget.locator("[data-action=approve]")).toBeDisabled();
  await expect(widget.locator(".notice")).toHaveText("Hôte déconnecté");
  await widget.screenshot({ path: path.join(output, "offline.png") });
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [newPlan],
    labels,
  });
  await widget.locator("header button").click();
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.screenshot({ path: path.join(output, "reduced.png") });
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [newPlan],
    labels,
  });
  await expect(widget.locator(".pill")).toBeVisible();
  const nextPlan = { ...plan, key: JSON.stringify(["host", "agent", "plan3"]), requestId: "plan3" };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [nextPlan],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("[data-action=approve]").click();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Paseo")
        ?.isFocused(),
    ),
  ).toBe(false);
  await expect(widget.locator(".pill")).toHaveText(/Paseo.*0/);
  // Another application window shares the queue, then takes over when its peer closes.
  const secondOpened = app.waitForEvent("window");
  await app.evaluate(() => globalThis.createWidgetOwner());
  const secondOwner = await secondOpened;
  await secondOwner.waitForFunction(() => Boolean(window.paseoDesktop?.agentWidget));
  await secondOwner.evaluate(() => {
    window.widgetActions = [];
    window.widgetMode = "normal";
    window.paseoDesktop.agentWidget.onAction((delivery) => {
      window.widgetActions.push(delivery.action);
      if (window.widgetMode === "silent") return;
      if (window.widgetMode === "long") {
        const keepAlive = setInterval(() => {
          void window.paseoDesktop.agentWidget.progress(delivery.operationId);
        }, 10_000);
        setTimeout(() => {
          clearInterval(keepAlive);
          void window.paseoDesktop.agentWidget.result({
            operationId: delivery.operationId,
            error: null,
          });
        }, 33_000);
        return;
      }
      void window.paseoDesktop.agentWidget.result({
        operationId: delivery.operationId,
        error: null,
      });
    });
  });
  const sharedPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "shared"]),
    requestId: "shared",
  };
  const sharedSnapshot = { serverId: "host", online: true, requests: [sharedPlan], labels };
  await owner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await secondOwner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("header button").click();
  await expect(widget.locator(".pill")).toBeVisible();
  await secondOwner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator(".queue span")).toHaveText("1 / 1");
  await widget.locator("#comment").fill("Conserver cette consigne lors des mises à jour.");
  await owner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await expect(widget.locator("#comment")).toBeFocused();
  await expect(widget.locator("#comment")).toHaveValue(
    "Conserver cette consigne lors des mises à jour.",
  );
  await owner.close();
  await expect(widget.locator(".queue span")).toHaveText("1 / 1");
  await widget.locator("[data-action=approve]").click();
  await expect(widget.locator(".pill")).toHaveText(/Paseo.*0/);
  expect(
    await secondOwner.evaluate(() => window.widgetActions.map((action) => action.type)),
  ).toEqual(["approve"]);
  const longPlan = { ...plan, key: JSON.stringify(["host", "agent", "long"]), requestId: "long" };
  await secondOwner.evaluate(() => (window.widgetMode = "long"));
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [longPlan],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator('[data-action="handoff"]').first().click();
  await expect(widget.locator('[data-action="handoff"]').first()).toBeDisabled();
  await expect.poll(() => secondOwner.evaluate(() => window.widgetActions.length)).toBe(2);
  await widget.locator("header button").click();
  await expect(widget.locator(".pill")).toBeVisible();
  const duringSendPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "during-send"]),
    requestId: "during-send",
  };
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [duringSendPlan],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Paseo")
            ?.isVisible(),
        ),
      { timeout: 40_000 },
    )
    .toBe(true);
  await expect(widget.locator(".notice")).toHaveText("Réponse envoyée", { timeout: 40_000 });
  expect(await secondOwner.evaluate(() => window.widgetActions.length)).toBe(2);

  const silentPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "silent"]),
    requestId: "silent",
  };
  await secondOwner.evaluate(() => (window.widgetMode = "silent"));
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [silentPlan],
    labels,
  });
  await expect(widget.locator("#comment")).toBeVisible();
  await widget.locator("#comment").fill("Brouillon à préserver");
  await widget.locator('[data-action="handoff"]').first().click();
  await expect(widget.locator(".notice.error")).toContainText("No confirmation", {
    timeout: 35_000,
  });
  await expect(widget.locator("#comment")).toHaveValue("Brouillon à préserver");
  await widget.screenshot({ path: path.join(output, "handoff-timeout.png") });
  await secondOwner.evaluate(() => (window.widgetMode = "normal"));
  await widget.locator('[data-action="handoff"]').first().click();
  await expect(widget.locator(".pill")).toHaveText(/Paseo.*0/);
  const tallPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "tall"]),
    requestId: "tall",
    planHtml: `<h1>Plan long</h1>${Array.from({ length: 80 }, (_, index) => `<p>Étape ${index + 1}</p>`).join("")}`,
  };
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [tallPlan],
    labels,
  });
  const body = widget.locator(".body");
  await expect(body).toBeVisible();
  const scrollMetrics = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  const cappedHeight = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Paseo");
    return {
      height: win.getBounds().height,
      max: screen.getDisplayMatching(win.getBounds()).workArea.height - 32,
    };
  });
  expect(cappedHeight.height).toBe(cappedHeight.max);
  await body.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(widget.locator("[data-action=approve]")).toBeVisible();
  await widget.screenshot({ path: path.join(output, "plan-long.png") });
  const sizeChecks = await app.evaluate(() => {
    const widgetBounds = globalThis.widgetBounds;
    return [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
    ].map((size) => ({ size, bounds: widgetBounds({ x: 0, y: 0, ...size }, false) }));
  });
  for (const { size, bounds } of sizeChecks) {
    expect(bounds.width).toBe(512);
    expect(bounds.y).toBe(16);
    expect(bounds.height).toBe(size.height - 32);
    expect(bounds.x + bounds.width).toBe(size.width - 16);
    expect(bounds.y + bounds.height).toBe(size.height - 16);
  }
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [{ ...tallPlan, planHtml: plan.planHtml }],
    labels,
  });
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.getTitle() === "Paseo")
            .getBounds().height,
      ),
    )
    .toBeLessThan(cappedHeight.height);
  // Display changes reapply the stored natural height through the production handler.
  const screenChecks = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Paseo");
    const original = screen.getDisplayMatching;
    const display = original.call(screen, win.getBounds());
    const initialHeight = win.getBounds().height;
    try {
      screen.getDisplayMatching = () => ({
        ...display,
        workArea: { x: 0, y: 0, width: 1280, height: 500 },
      });
      screen.emit("display-metrics-changed", {}, display, ["workArea"]);
      const smallHeight = win.getBounds().height;
      screen.getDisplayMatching = () => ({
        ...display,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      });
      screen.emit("display-metrics-changed", {}, display, ["workArea"]);
      return { smallHeight, restoredHeight: win.getBounds().height, initialHeight };
    } finally {
      screen.getDisplayMatching = original;
      screen.emit("display-metrics-changed", {}, display, ["workArea"]);
    }
  });
  expect(screenChecks.smallHeight).toBe(468);
  expect(screenChecks.restoredHeight).toBe(screenChecks.initialHeight);
  expect(errors).toEqual([]);
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        passed: true,
        geometry,
        actions,
        cappedHeight,
        screenChecks,
        applicationBeforeHandoff,
        mainFocusBeforeHandoff,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: non-activating widget with a visible main window, adaptive content height, feedback failure/retry, app and widget responses, questions, drafts, stale snapshots, offline, persistent zero-count pill, multi-window takeover and long-content scrolling.",
  );
} finally {
  await app.close();
  if (previousBundleId) {
    execFileSync("osascript", ["-e", `tell application id "${previousBundleId}" to activate`]);
  }
  await rm(home, { recursive: true, force: true });
}
