import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyPluginExample } from "./plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { gotoAppShell, openSettings } from "./app";
import { openCompactSettings, openHostSection } from "./settings";
import { getServerId } from "./server-id";
import { openMobileAgentSidebar } from "./sidebar";
import { expect, type Page } from "../fixtures";
import { TerminalE2EHarness } from "./terminal-dsl";

export async function installBrowserSerial(
  hardware: "browser" | "echo" | "cancel" | "open-failure",
  failRelease = false,
) {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("browser-serial");
  try {
    if (hardware !== "browser") {
      // Inject only the typed hardware port; retain production UI, controller,
      // WebSocket transport, daemon RPC handlers, and host TCP sockets.
      const file = path.join(example.directory, "index.client.tsx");
      const source = await readFile(file, "utf8");
      const injected = source
        .replace('from "./client/web"', 'from "./client/serial-browser.fake"')
        .replace(
          "import { getSerialBrowser }",
          "import { getFakeSerialBrowser as getSerialBrowser }",
        )
        .replace("getSerialBrowser()", `getSerialBrowser("${hardware}")`);
      if (!injected.includes("import { getFakeSerialBrowser as getSerialBrowser }"))
        throw new Error("Synthetic serial hardware was not injected");
      await writeFile(file, injected);
    }
    if (failRelease) {
      const entry = path.join(example.directory, "index.server.ts");
      const source = await readFile(entry, "utf8");
      if (!source.includes("bridge.release(input.token)"))
        throw new Error("Release handler missing");
      await writeFile(
        entry,
        source.replace(
          "bridge.release(input.token)",
          'Promise.reject(new Error("Host tool release failed."))',
        ),
      );
    }
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    return {
      disable: () => client.disablePlugin("browser-serial"),
      async cleanup() {
        await client.removePlugin("browser-serial");
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
      },
    };
  } catch (error) {
    await client.close();
    await example.cleanup();
    throw error;
  }
}

export async function openBrowserSerial(page: Page, compact = false) {
  await gotoAppShell(page);
  if (compact) await openCompactSettings(page, new URL(page.url()).pathname);
  else await openSettings(page);
  await openHostSection(page, getServerId(), "plugins");
  await page.getByRole("button", { name: "Actions for browser-serial", exact: true }).click();
  await page.getByRole("menuitem", { name: "USB serial", exact: true }).click();
  await expect(page.getByText("Browser USB serial experiment", { exact: true })).toBeVisible();
}

export async function openBrowserSerialFromSidebar(page: Page, compact = false) {
  await gotoAppShell(page);
  if (compact) await openMobileAgentSidebar(page);
  await page.getByRole("button", { name: "USB serial", exact: true }).click();
  await expect(page.getByText("Browser USB serial experiment", { exact: true })).toBeVisible();
}

export async function startSerialAgentTool(page: Page, endpoint?: string, startupBanner = true) {
  const text = endpoint ?? (await page.getByText(/^Host TCP: 127\.0\.0\.1:\d+$/).textContent());
  const port = Number(text?.match(/:(\d+)$/)?.[1]);
  if (!port) throw new Error("Missing serial TCP endpoint");
  const terminal = await TerminalE2EHarness.create({ tempPrefix: "browser-serial-tool-" });
  const result = path.join(terminal.tempRepo.path, "serial-result.txt");
  const release = path.join(terminal.tempRepo.path, "release-tool");
  const script = `
const net = require('node:net');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = process.argv[2];
const payload = Buffer.from(Array.from({length:70001}, (_, i) => i % 256));
let bytes = Buffer.alloc(0), stage = Number(process.argv[3]) ? 0 : 1;
const socket = net.connect(Number(process.argv[1]), '127.0.0.1');
socket.on('connect', () => { if(stage===1) socket.write(payload); });
socket.on('error', error => { fs.writeFileSync(output, String(error)); process.exitCode=1; });
socket.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  if (stage === 0 && bytes.length >= 7) {
    assert.deepEqual(bytes.subarray(0,7), Buffer.from([82,69,65,68,89,0,255]));
    bytes = bytes.subarray(7); stage=1; socket.write(payload);
  }
  if (stage === 1 && bytes.length >= payload.length) {
    assert.deepEqual(bytes, payload); stage=2; fs.writeFileSync(output,'70001 bytes round-tripped');
  }
});
const releasing = setInterval(() => { if(fs.existsSync(process.argv[4])) socket.end(); },100);
socket.on('close', () => { clearInterval(releasing); if(stage===2) fs.writeFileSync(output,'tool disconnected'); });
setTimeout(() => { socket.destroy(); }, 60000).unref();
`;
  try {
    await terminal.createTerminal({
      name: "Serial agent tool",
      command: process.execPath,
      args: ["-e", script, String(port), result, startupBanner ? "1" : "0", release],
    });
    await expect
      .poll(() => readFile(result, "utf8").catch(() => ""), { timeout: 15000 })
      .toBe("70001 bytes round-tripped");
    return {
      release: () => writeFile(release, "release"),
      async expectDisconnected() {
        await expect.poll(() => readFile(result, "utf8").catch(() => "")).toBe("tool disconnected");
      },
      cleanup: () => terminal.cleanup(),
    };
  } catch (error) {
    await terminal.cleanup();
    throw error;
  }
}
