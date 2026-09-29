// Real-Electron check of the browser password manager: the production guest preload and main
// handlers from dist/, a registered <webview> guest, and a local login page. Input goes through
// sendInputEvent so the page sees trusted events with user activation.
//
//   npm run test:e2e:browser-passwords --workspace=@getpaseo/desktop   (prefix xvfb-run -a on a headless box)
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const DIST = path.join(__dirname, "..", "dist", "features");
const { PaseoBrowserWebviewRegistry } = require(path.join(DIST, "browser-webviews", "registry.js"));
const { BrowserPasswords, registerBrowserPasswordsIpc } = require(
  path.join(DIST, "browser-passwords", "index.js"),
);
const { PasswordVault } = require(path.join(DIST, "browser-passwords", "vault.js"));
const GUEST_PRELOAD = path.join(DIST, "browser-keyboard", "guest-preload.js");

const PASSWORD = "hunter2-e2e-secret";
const USERNAME = "ada@example.com";
const TIMEOUT_MS = 10_000;

const LOGIN_PAGE = `<!doctype html><html><body>
<form id="login" method="post" action="/welcome">
  <label>E-Mail <input id="username" name="email" type="email" autocomplete="username"></label>
  <label>Passwort <input id="password" name="password" type="password"></label>
  <button id="submit" type="submit">Anmelden</button>
</form>
</body></html>`;

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS),
    ),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      request.resume();
      request.on("end", () => response.end("<!doctype html><h1>Willkommen</h1>"));
      return;
    }
    response.end(LOGIN_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function clickElement(guest, selector) {
  const rect = await guest.executeJavaScript(
    `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`,
  );
  const { x, y, width, height } = JSON.parse(rect);
  const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  guest.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  guest.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await delay(100);
}

function inputValue(guest, selector) {
  return guest.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`);
}

function waitForLoad(guest) {
  return withTimeout(
    new Promise((resolve) => guest.once("did-finish-load", resolve)),
    "guest load",
  );
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-browser-passwords-e2e-"));
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hostPreload = path.join(tempDir, "host-preload.js");
  fs.writeFileSync(
    hostPreload,
    `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("e2eHost", {
  respond: (input) => ipcRenderer.invoke("paseo:browser:passwords:respond", input),
});
ipcRenderer.on("paseo:event:browser-save-password-request", (_event, payload) => {
  ipcRenderer.send("e2e:host-event", payload);
});`,
  );
  const hostPage = path.join(tempDir, "host.html");
  fs.writeFileSync(
    hostPage,
    `<!doctype html><body style="margin:0"><webview src="${origin}/login" partition="e2e-passwords" style="width:800px;height:600px;display:inline-flex"></webview></body>`,
  );

  const registry = new PaseoBrowserWebviewRegistry();
  const vault = new PasswordVault({
    filePath: path.join(tempDir, "browser-passwords.json"),
    // safeStorage has no keyring under Xvfb; the fake keeps the rest of the path real.
    crypto: {
      isAvailable: () => true,
      encrypt: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
      decrypt: (cipherText) => cipherText.toString("utf8").slice(4),
    },
  });
  let hostId = -1;
  registerBrowserPasswordsIpc(
    ipcMain,
    new BrowserPasswords({
      vault,
      registry,
      isHostSender: (sender) => sender.id === hostId,
      randomId: () => `request-${Date.now()}`,
      now: Date.now,
      warn: (event, details) => console.warn(event, details),
    }),
  );
  const hostEvents = [];
  ipcMain.on("e2e:host-event", (_event, payload) => hostEvents.push(payload));

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: {
      preload: hostPreload,
      webviewTag: true,
      contextIsolation: true,
      sandbox: false,
    },
  });
  hostId = win.webContents.id;
  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.preload = GUEST_PRELOAD;
  });
  const guestPromise = new Promise((resolve) => {
    win.webContents.once("did-attach-webview", (_event, contents) => resolve(contents));
  });
  await win.loadFile(hostPage);
  const guest = await withTimeout(guestPromise, "webview attach");
  registry.registerWebContents({
    webContentsId: guest.id,
    browserId: "browser-e2e",
    hostWebContentsId: hostId,
  });
  if (guest.isLoading()) await waitForLoad(guest);

  // Script-driven submit carries no user activation and must be ignored.
  await guest.executeJavaScript(`
    document.querySelector("#username").value = "script@example.com";
    document.querySelector("#password").value = "script-password";
    document.querySelector("#login").addEventListener("submit", (e) => e.preventDefault(), { once: true });
    document.querySelector("#submit").click();
  `);
  await delay(300);
  check(hostEvents.length === 0, "script-driven submit sends no save request");
  await guest.executeJavaScript(`
    document.querySelector("#username").value = "";
    document.querySelector("#password").value = "";
  `);

  await clickElement(guest, "#username");
  guest.insertText(USERNAME);
  await clickElement(guest, "#password");
  guest.insertText(PASSWORD);
  const welcomeLoad = waitForLoad(guest);
  await clickElement(guest, "#submit");
  await welcomeLoad;
  const deadline = Date.now() + TIMEOUT_MS;
  while (hostEvents.length === 0 && Date.now() < deadline) await delay(50);

  check(hostEvents.length === 1, "one save request reaches the host");
  const request = hostEvents[0];
  check(request.origin === origin, `origin comes from the frame (${request.origin})`);
  check(request.username === USERNAME, "username is detected");
  check(request.browserId === "browser-e2e" && request.update === false, "browser id and update");
  check(!JSON.stringify(request).includes(PASSWORD), "host payload has no password");
  check(vault.list().length === 0, "nothing is stored before the host answers");

  const accepted = await win.webContents.executeJavaScript(
    `window.e2eHost.respond(${JSON.stringify({ requestId: request.requestId, action: "save" })})`,
  );
  check(accepted === true, "host answer 'save' is accepted");
  check(vault.has(origin, USERNAME, PASSWORD), "vault stores the login for the frame origin");

  const loginLoad = waitForLoad(guest);
  await guest.loadURL(`${origin}/login`);
  await loginLoad.catch(() => {});

  await guest.executeJavaScript(`document.querySelector("#username").focus()`);
  await delay(300);
  check(
    (await inputValue(guest, "#password")) === "",
    "script focus() without a gesture does not fill",
  );
  await guest.executeJavaScript(`document.activeElement.blur()`);

  await clickElement(guest, "#username");
  const fillDeadline = Date.now() + TIMEOUT_MS;
  while ((await inputValue(guest, "#password")) === "" && Date.now() < fillDeadline) {
    await delay(50);
  }
  check((await inputValue(guest, "#username")) === USERNAME, "click fills the username");
  check((await inputValue(guest, "#password")) === PASSWORD, "click fills the password");

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function main() {
  await app.whenReady();
  try {
    await run();
    console.log("browser-passwords e2e: OK");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

void main();
