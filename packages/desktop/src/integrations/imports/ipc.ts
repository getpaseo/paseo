import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { connectHostAutomation } from "@getpaseo/client/node";
import { runImport } from "@getpaseo/import";
import { ipcMain } from "electron";
import {
  resolveDesktopAppVersion,
  resolveDesktopDaemonStatus,
} from "../../daemon/daemon-manager.js";
import { DesktopImportRunner, type ImportTarget } from "./runner.js";

const imports = new DesktopImportRunner({
  sources: new Map(process.platform === "darwin" ? [["conductor", { kind: "conductor" }]] : []),
  runImport,
  connect: (target) =>
    connectHostAutomation({
      appVersion: target.appVersion,
      host: target.listen ?? undefined,
      env: { PASEO_HOME: target.home },
    }),
  getTarget: async (): Promise<ImportTarget> => {
    const status = await resolveDesktopDaemonStatus();
    return {
      status: status.status,
      desktopManaged: status.desktopManaged,
      listen: status.listen,
      home: status.home,
      appVersion: resolveDesktopAppVersion(),
      daemonVersion: status.version,
      passwordProtected: Boolean(process.env.PASEO_PASSWORD?.trim()) || hasPassword(status.home),
    };
  },
});

export function registerImportIpc(): void {
  ipcMain.handle("paseo:imports:availability", (_event, input: unknown) =>
    imports.availability(readSource(input)),
  );
  ipcMain.handle("paseo:imports:run", async (event, input: unknown) => {
    const source = readSource(input);
    return {
      runId: await imports.run(source, (output) => {
        if (!event.sender.isDestroyed()) event.sender.send("paseo:imports:output", output);
      }),
    };
  });
}

function readSource(input: unknown): string {
  if (typeof input !== "object" || input === null || !("source" in input)) {
    throw new Error("Import source is required.");
  }
  const source = (input as { source?: unknown }).source;
  if (typeof source !== "string") throw new Error("Import source is required.");
  return source;
}

function hasPassword(paseoHome: string): boolean {
  const configPath = path.join(paseoHome, "config.json");
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      daemon?: { auth?: { password?: unknown } };
    };
    return typeof config.daemon?.auth?.password === "string";
  } catch {
    return true;
  }
}
