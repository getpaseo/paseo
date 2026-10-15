// Loads the actual packaged document and sandboxed preload, without starting a daemon or agent.
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const archive = process.argv[2];
const home = mkdtempSync(path.join(tmpdir(), "paseo-release-widget-"));
app.setPath("userData", home);
const labels = {
  plan: "Plan à valider",
  question: "Question",
  execute: "Exécuter",
  comment: "Demander une modification",
  sendComment: "Envoyer",
  handoff: "Transmettre",
  submit: "Répondre",
  next: "Suivant",
  close: "Fermer",
  minimize: "Réduire",
  pending: "En attente",
  sent: "Envoyé",
  offline: "Hors ligne",
  failed: "Échec",
};
const display = {
  labels,
  requests: [
    {
      key: "verification",
      serverId: "isolated",
      agentId: "fixture",
      requestId: "fixture",
      agentTitle: "Publication locale",
      workspace: "Vérification isolée",
      kind: "plan",
      title: "Fiabiliser les publications",
      planHtml:
        "<h1>Fiabiliser les publications</h1><p>Conserver les couleurs et les actions après chaque mise à jour.</p>",
      planText: "Verification",
      planCallId: "fixture",
      handoffProfiles: [{ id: "review", name: "Relecture" }],
      questions: [],
      canApprove: true,
      online: true,
    },
  ],
};
ipcMain.handle("paseo:agent-widget:ready", () => display);
ipcMain.handle("paseo:agent-widget:resize", () => undefined);
ipcMain.handle("paseo:agent-widget:action", () => {
  throw new Error("Verification must not execute actions");
});
app
  .whenReady()
  .then(async () => {
    const { widgetDocument } = require(
      path.join(archive, "dist/features/agent-widget/document.js"),
    );
    const win = new BrowserWindow({
      width: 540,
      height: 760,
      show: false,
      webPreferences: {
        preload: path.join(archive, "dist/features/agent-widget/preload.js"),
        sandbox: true,
        contextIsolation: true,
      },
    });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(widgetDocument)}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript('Boolean(document.querySelector("header"))'))
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const colors = await win.webContents.executeJavaScript(
      '({ body: getComputedStyle(document.querySelector(".sheet")).backgroundColor, header: getComputedStyle(document.querySelector("header")).backgroundColor, text: document.body.textContent })',
    );
    assert.equal(colors.body, "rgb(249, 247, 244)");
    assert.equal(colors.header, "rgb(56, 53, 52)");
    const header = await win.webContents.executeJavaScript(`({
      color: getComputedStyle(document.querySelector('header')).color,
      identityDisplay: getComputedStyle(document.querySelector('.header-identity')).display,
      drag: getComputedStyle(document.querySelector('header')).getPropertyValue('-webkit-app-region'),
      imagePolicy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    })`);
    assert.equal(header.color, "rgb(249, 247, 244)");
    assert.equal(header.identityDisplay, "flex");
    assert.equal(header.drag, "drag");
    assert.match(header.imagePolicy, /img-src data:/);
    assert.match(colors.text, /Exécuter/);
    assert.match(colors.text, /Relecture/);
    if (process.env.PASEO_LOCAL_RELEASE_ARTIFACTS) {
      mkdirSync(process.env.PASEO_LOCAL_RELEASE_ARTIFACTS, { recursive: true });
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(
        path.join(process.env.PASEO_LOCAL_RELEASE_ARTIFACTS, "external-plan-popup.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    win.destroy();
    rmSync(home, { recursive: true, force: true });
    return app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
