import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, dialog, ipcMain, shell } from "electron";

const executeFile = promisify(execFile);
const EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".command",
  ".sh",
  ".pkg",
  ".dmg",
  ".msi",
  ".ps1",
]);

export function validateFileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("A file name is required.");
  }
  const name = path.basename(value.replace(/\\/g, "/"));
  if (!name || name === "." || name === "..") throw new Error("Invalid file name.");
  return name;
}

async function existingFile(value: unknown): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("An absolute local file path is required.");
  }
  if (!(await stat(value)).isFile()) throw new Error("The requested path is not a file.");
  return value;
}

export function registerFileHandlers(): void {
  ipcMain.handle(
    "paseo:files:materialize",
    async (_event, input: { name: string; bytes: Uint8Array }) => {
      const name = validateFileName(input?.name);
      if (!(input.bytes instanceof Uint8Array)) throw new Error("File bytes are required.");
      const directory = path.join(app.getPath("temp"), "paseo-enhanced-files", randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, name);
      await writeFile(target, input.bytes, { mode: 0o600 });
      return target;
    },
  );
  ipcMain.handle("paseo:files:chooseApplication", async () => {
    if (process.platform !== "darwin")
      throw new Error("Choosing an application is currently supported on macOS.");
    const result = await dialog.showOpenDialog({
      title: "Open with…",
      defaultPath: "/Applications",
      properties: ["openFile"],
      filters: [{ name: "Applications", extensions: ["app"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(
    "paseo:files:open",
    async (_event, input: { path: string; application?: string }) => {
      const file = await existingFile(input?.path);
      if (!input.application && EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        throw new Error(
          "Choose a document editor to inspect this file, or save it without running it.",
        );
      }
      if (input.application) {
        if (
          process.platform !== "darwin" ||
          !path.isAbsolute(input.application) ||
          !input.application.endsWith(".app")
        ) {
          throw new Error("Choose an installed macOS application.");
        }
        await stat(input.application);
        await executeFile("/usr/bin/open", ["-a", input.application, "--", file]);
        return;
      }
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle("paseo:files:reveal", async (_event, value: unknown) => {
    shell.showItemInFolder(await existingFile(value));
  });
  ipcMain.handle("paseo:files:save", async (_event, input: { name: string; bytes: Uint8Array }) => {
    const name = validateFileName(input?.name);
    if (!(input.bytes instanceof Uint8Array)) throw new Error("File bytes are required.");
    const result = await dialog.showSaveDialog({ defaultPath: name });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, input.bytes);
    return result.filePath;
  });
}
