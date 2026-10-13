const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { BrowserWindow } = require("electron");
const { registerAgentWidget } = require("../dist/features/agent-widget/index.js");

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function runAgentWidgetGroup(outDir) {
  const widget = registerAgentWidget();
  const owner = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "../dist/preload.js"), sandbox: true },
  });
  widget.attach(owner);
  const labels = {
    plan: "Plan prêt",
    question: "Réponse attendue",
    execute: "Exécuter",
    comment: "Commentaire",
    sendComment: "Envoyer",
    handoff: "Transmettre",
    submit: "Répondre",
    next: "Suivant",
    close: "Fermer",
    minimize: "Réduire",
    pending: "Envoi…",
    sent: "Réponse envoyée",
    offline: "Hors ligne",
    failed: "Échec",
  };
  const request = {
    key: "question-1",
    serverId: "host",
    agentId: "agent",
    requestId: "request",
    agentTitle: "Conversation",
    workspace: "Paseo",
    kind: "question",
    title: "Question",
    project: { name: "Paseo", branchName: "lethal-liger", color: "#7a6aa8" },
    planHtml: "",
    canApprove: false,
    questions: [
      {
        question: "Quelle option préférez-vous ?",
        header: "Choix",
        options: [
          { label: "Première option", description: "Continuer avec cette proposition." },
          { label: "Deuxième option", description: "Explorer une autre piste." },
        ],
        multiSelect: false,
        allowOther: true,
        allowEmpty: false,
      },
    ],
  };
  const publish = (requests) =>
    owner.webContents.executeJavaScript(
      `window.paseoDesktop.agentWidget.publish(${JSON.stringify({ serverId: "host", online: true, labels, requests })})`,
    );
  try {
    await owner.loadURL("data:text/html,<title>Widget publisher</title>");
    await publish([]);
    assert.equal(BrowserWindow.getAllWindows().some(widget.isWindow), false);
    await publish([request]);
    const window = BrowserWindow.getAllWindows().find(widget.isWindow);
    assert.ok(window);
    await waitFor(() => window.isVisible(), "Pending conversation did not appear");
    await publish([]);
    assert.equal(window.isVisible(), false, "Empty widget must disappear");
    console.log("PASS agent-widget/empty-widget-hidden");
    await publish([request]);
    const click = (selector) =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).click()`,
      );
    await waitFor(
      () => window.webContents.executeJavaScript("!!document.querySelector('.queue')"),
      "Conversation did not render",
    );
    await click('.queue button[aria-label="Fermer"]');
    await waitFor(() => !window.isVisible(), "Close must hide the widget");
    await publish([request]);
    assert.equal(window.isVisible(), false, "An unchanged request must stay hidden");
    const next = { ...request, key: "question-2" };
    await publish([request, next]);
    await waitFor(() => window.isVisible(), "A new request must reveal the widget");
    window.close();
    assert.equal(window.isVisible(), false, "Native close must hide the widget");
    await publish([next]);
    assert.equal(window.isVisible(), false, "Removing a request must not reveal the widget");
    console.log("PASS agent-widget/dismiss-until-new-request");
    await publish([{ ...request, key: "question-3" }]);
    await waitFor(
      () => window.webContents.executeJavaScript("!!document.querySelector('header')"),
      "Header did not render",
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('header')).webkitAppRegion",
      ),
      "drag",
    );
    const capture = async (name) =>
      fs.writeFile(path.join(outDir, name), (await window.webContents.capturePage()).toPNG());
    const drag = async (selector) => {
      const before = window.getBounds();
      if (process.platform === "darwin") {
        const mouse = path.join(outDir, "titlebar-drag-mouse");
        await promisify(execFile)("clang", [
          "-O2",
          "-o",
          mouse,
          path.join(__dirname, "titlebar-drag-mouse.m"),
          "-framework",
          "ApplicationServices",
        ]);
        const point = await window.webContents.executeJavaScript(
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 24, y: r.top + r.height / 2 }; })()`,
        );
        await delay(200);
        await promisify(execFile)(
          mouse,
          [
            "drag",
            before.x + point.x,
            before.y + point.y,
            before.x + point.x - 80,
            before.y + point.y,
          ].map(String),
        );
      } else {
        window.setPosition(before.x - 80, before.y);
      }
      await waitFor(() => window.getBounds().x === before.x - 80, "Window did not move");
      return window.getBounds();
    };
    const moved = await drag("header");
    await publish([{ ...request, key: "question-3", title: "Updated" }]);
    assert.deepEqual(window.getBounds(), moved, "Publishing must preserve the position");
    await capture("agent-widget-expanded.png");
    await click('[data-action="reduce"]');
    await waitFor(
      () => window.webContents.executeJavaScript("!!document.querySelector('.pill')"),
      "Widget did not reduce",
    );
    assert.equal(window.getBounds().x, moved.x, "Reducing must preserve the position");
    assert.equal(
      await window.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.pill')).webkitAppRegion",
      ),
      "drag",
    );
    const reducedMoved = await drag(".pill");
    await capture("agent-widget-reduced.png");
    await click('[data-action="restore"]');
    await waitFor(
      () => window.webContents.executeJavaScript("!!document.querySelector('header')"),
      "Widget did not restore",
    );
    assert.equal(window.getBounds().x, reducedMoved.x, "Restoring must preserve the position");
    await click('[data-action="reduce"]');
    await waitFor(
      () => window.webContents.executeJavaScript("!!document.querySelector('.pill')"),
      "Widget did not reduce again",
    );
    await click('[data-action="hide"]');
    await waitFor(() => !window.isVisible(), "Reduced widget must be dismissible");
    console.log("PASS agent-widget/move-reduce-restore-hide");
  } finally {
    owner.destroy();
  }
}

module.exports = { runAgentWidgetGroup };
