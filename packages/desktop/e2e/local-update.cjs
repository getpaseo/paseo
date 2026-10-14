// Real Electron relaunch and IPC; a fast clock keeps the same production idle policy.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.argv[2];
const desktop = path.resolve(__dirname, "..");
const state = path.join(root, "local-activation.json");
const first = !fs.existsSync(path.join(root, "started"));
app.setPath("userData", root);
app.on("window-all-closed", () => {});
const oldId = "a".repeat(40),
  newId = "b".repeat(40);
const active = first ? oldId : newId;
const { registerLocalUpdate } = require(path.join(desktop, "dist/features/local-update.js"));
let beforeQuit = false;
app.on("before-quit", () => {
  beforeQuit = true;
});
app
  .whenReady()
  .then(async () => {
    fs.writeFileSync(path.join(root, "started"), "yes");
    fs.writeFileSync(path.join(root, "local-release.json"), JSON.stringify({ commit: newId }));
    let restored;
    if (!first) {
      restored = JSON.parse(fs.readFileSync(state));
      assert.equal(restored.windows.length, 2);
      assert.equal(restored.target, newId);
      assert.equal(restored.popup.message, "Commentaire non envoyé");
      assert.equal(fs.readFileSync(path.join(root, "draft"), "utf8"), "Brouillon conservé");
    }
    const update = registerLocalUpdate(active, {
      resourcesPath: root,
      now: () => Date.now() * 100,
    });
    ipcMain.handle("fixture:checkpoint", () => {
      fs.writeFileSync(path.join(root, "draft"), "Brouillon conservé");
      return true;
    });
    const preload = path.join(root, "fixture-preload.cjs");
    fs.writeFileSync(
      preload,
      `const { ipcRenderer }=require('electron');
    const popup=process.argv.includes('--fixture-popup');
    ipcRenderer.on('paseo:local-update:prepare', async (_e, token) => {
      await ipcRenderer.invoke('fixture:checkpoint');
      await ipcRenderer.invoke('paseo:local-update:prepared', token, {ok:true,state:popup?{message:'Commentaire non envoyé'}:undefined});
    });
    window.addEventListener('DOMContentLoaded',()=>{ void ipcRenderer.invoke('paseo:local-update:ready', ${JSON.stringify(active)}); });`,
    );
    for (let index = 0; index < 3; index++) {
      const win = new BrowserWindow({
        show: false,
        width: 620 + index * 10,
        height: 480,
        webPreferences: {
          preload,
          sandbox: true,
          additionalArguments: index === 2 ? ["--fixture-popup"] : [],
        },
      });
      update.attach(win, index === 2);
      await win.loadURL("data:text/html,<html><body>Isolated release verification</body></html>");
    }
    if (!first) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = JSON.parse(fs.readFileSync(path.join(root, "local-release-status.json")));
      assert.equal(status.verified, true);
      assert.equal(status.active, newId);
      assert.equal(beforeQuit, false);
      fs.writeFileSync(
        path.join(root, "result.json"),
        JSON.stringify({
          ok: true,
          windows: restored.windows.length,
          popup: restored.popup,
          active: status.active,
        }),
      );
      return app.exit(0);
    }
    return undefined;
  })
  .catch((error) => {
    fs.writeFileSync(path.join(root, "error.txt"), String(error.stack));
    app.exit(1);
  });
