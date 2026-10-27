const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

async function runBrowserUploadAcceptance(options = {}) {
  const service = options.service ?? require("../dist/features/browser-automation/service.js");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-upload-"));
  const source = path.join(workspace, "proof.txt");
  const bytes = Buffer.from(
    ["HIDDEN_UPLOAD_PROOF", "17", "-4", "8", ""].join(String.fromCharCode(10)),
    "utf8",
  );
  await fs.writeFile(source, bytes, { flag: "wx" });
  let resolveReceived;
  const server = http.createServer((request, response) => {
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.end("ok");
        resolveReceived(Buffer.concat(chunks));
      });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'nonce-proof'; connect-src 'self'",
    });
    response.end(
      '<!doctype html><title>Hidden upload</title><h1>Hidden upload</h1><div hidden><input id="attachment" type="file" aria-label="Hidden attachment"><input id="type" type="file" aria-label="Selector attachment"><input type="file" disabled aria-label="Disabled attachment"></div><input id="visible" type="file" aria-label="Visible attachment"><script nonce="proof">for(const input of document.querySelectorAll("div input[type=file]")){input.addEventListener("change",async e=>{const data=await e.target.files[0].arrayBuffer();await fetch("/verify",{method:"POST",body:data});});}</script>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const contents = window.webContents;
  const commands = [];
  let chooserEvents = 0;
  let deadline;
  try {
    await contents.loadURL("http://127.0.0.1:" + server.address().port);
    contents.debugger.attach("1.3");
    contents.debugger.on("message", (_event, method) => {
      if (method === "Page.fileChooserOpened") chooserEvents++;
    });
    await contents.debugger.sendCommand("Page.enable");
    const tab = {
      id: contents.id,
      isDestroyed: () => contents.isDestroyed(),
      getURL: () => contents.getURL(),
      getTitle: () => contents.getTitle(),
      executeJavaScript: (code) => contents.executeJavaScript(code),
      sendDebugCommand: (command, parameters) => {
        commands.push(command);
        return contents.debugger.sendCommand(command, parameters);
      },
    };
    const browserId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "upload-acceptance";
    const registry = {
      getTabContents: (id) => (id === browserId ? tab : null),
      getBrowserWorkspaceId: () => workspaceId,
    };
    const execute = (command) =>
      service.executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "upload-e2e",
          cwd: workspace,
          workspaceId,
          command,
        },
        registry,
      );
    const snapshot = await execute({ command: "snapshot", args: { browserId } });
    assert.equal(snapshot.ok, true);
    assert.match(snapshot.result.snapshot, /Hidden attachment.*type=file hidden=true.*ref=@e/);
    assert.doesNotMatch(snapshot.result.snapshot, /Disabled attachment/);
    assert.equal(snapshot.result.snapshot.match(/Visible attachment/g).length, 1);
    const ref = snapshot.result.snapshot.match(/Hidden attachment.*ref=(@e[0-9]+)/)[1];
    async function uploadAndRead(locator) {
      const received = new Promise((resolve) => {
        resolveReceived = resolve;
      });
      const uploaded = await execute({
        command: "upload",
        args: { browserId, ...locator, filePaths: [source] },
      });
      assert.equal(uploaded.ok, true);
      const actual = await Promise.race([
        received,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Page did not read actual file bytes")),
            5000,
          );
        }),
      ]);
      clearTimeout(deadline);
      assert.deepEqual(actual, bytes);
      return actual;
    }
    const actual = await uploadAndRead({ ref });
    await uploadAndRead({ selector: "#type" });
    assert.equal(chooserEvents, 0);
    const ambiguous = await execute({
      command: "upload",
      args: { browserId, selector: "input[type=file]", filePaths: [source] },
    });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error.message, /exactly one/);
    const nonFile = await execute({
      command: "upload",
      args: { browserId, selector: "h1", filePaths: [source] },
    });
    assert.equal(nonFile.ok, false);
    const outside = await execute({
      command: "upload",
      args: {
        browserId,
        selector: "#attachment",
        filePaths: [path.resolve(workspace, "../outside.txt")],
      },
    });
    assert.equal(outside.ok, false);
    assert.match(outside.error.message, /inside the agent workspace/);
    const result = {
      passed: true,
      hiddenSnapshotRef: ref,
      selectorAndRefAccepted: true,
      size: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex"),
      chooserEvents,
      cspKeptEnabled: true,
      ambiguousTargetRejected: true,
      nonFileTargetRejected: true,
      outsideWorkspaceRejected: true,
      commands,
    };
    if (options.evidencePath)
      await fs.writeFile(options.evidencePath, JSON.stringify(result, null, 2));
    return result;
  } finally {
    clearTimeout(deadline);
    if (!contents.isDestroyed()) {
      if (contents.debugger.isAttached()) contents.debugger.detach();
      window.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workspace, { recursive: true });
  }
}

module.exports = { runBrowserUploadAcceptance };
if (require.main === module) {
  app
    .whenReady()
    .then(() => runBrowserUploadAcceptance())
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
      return app.quit();
    })
    .catch((error) => {
      process.stderr.write(String(error) + String.fromCharCode(10));
      app.exit(1);
    });
}
