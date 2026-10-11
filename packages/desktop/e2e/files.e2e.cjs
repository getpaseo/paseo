const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../..");
const output = path.join(root, ".dev");
app.setPath("userData", path.join(output, "electron-files-profile"));
app
  .whenReady()
  .then(async () => {
    require(path.join(root, "packages/desktop/dist/features/files.js")).registerFileHandlers();
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(root, "packages/desktop/dist/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL("data:text/html,<html><body>File bridge test</body></html>");
    const created = await window.webContents.executeJavaScript(
      'window.paseoDesktop.files.materialize({ name: "报告 % # 中文.pdf", bytes: new Uint8Array([37,80,68,70,45]) })',
    );
    assert.equal(path.basename(created), "报告 % # 中文.pdf");
    assert.equal((await fs.readFile(created)).toString(), "%PDF-");
    assert.equal((await fs.stat(created)).mode & 0o777, 0o600);
    const destination = path.join(output, "saved-by-dialog.pdf");
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    await window.webContents.executeJavaScript(
      'window.paseoDesktop.files.save({ name: "saved.pdf", bytes: new Uint8Array([1,2,3,4]) })',
    );
    assert.deepEqual([...(await fs.readFile(destination))], [1, 2, 3, 4]);
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.equal(
      await window.webContents.executeJavaScript("window.paseoDesktop.files.chooseApplication()"),
      null,
    );
    const executable = path.join(output, "do-not-run.sh");
    await fs.writeFile(executable, "echo should-not-run");
    const refusal = await window.webContents.executeJavaScript(
      `window.paseoDesktop.files.open({path:${JSON.stringify(executable)}}).then(()=>"unexpected success",e=>e.message)`,
    );
    assert.match(refusal, /without running/);
    shell.openPath = async () => "No application associated with file";
    const failure = await window.webContents.executeJavaScript(
      `window.paseoDesktop.files.open({path:${JSON.stringify(created)}}).then(()=>"unexpected success",e=>e.message)`,
    );
    assert.match(failure, /No application/);
    let revealed = null;
    shell.showItemInFolder = (file) => {
      revealed = file;
    };
    await window.webContents.executeJavaScript(
      `window.paseoDesktop.files.reveal(${JSON.stringify(created)})`,
    );
    assert.equal(revealed, created);
    await fs.rm(path.dirname(created), { recursive: true, force: true });
    console.log(
      "PASS: real Electron preload/IPC preserves Unicode filenames and bytes, saves files, handles cancel/errors, and refuses automatic script execution",
    );
    window.destroy();
    app.exit(0);
    return true;
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
