import { dialog, ipcMain, BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

interface AskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

interface AskWithCheckboxOptions extends AskOptions {
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

interface OpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  createDirectory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface SaveTextOptions {
  title?: string;
  defaultPath: string;
  content: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;

function resolveDialogType(kind: AskOptions["kind"]): "warning" | "error" | "question" {
  if (kind === "warning") return "warning";
  if (kind === "error") return "error";
  return "question";
}

export function registerDialogHandlers(): void {
  ipcMain.handle("paseo:dialog:ask", async (event, message: string, options?: AskOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showMessageBox(win ?? BrowserWindow.getFocusedWindow()!, {
      type: resolveDialogType(options?.kind),
      title: options?.title ?? "Confirm",
      message,
      buttons: [options?.cancelLabel ?? "Cancel", options?.okLabel ?? "OK"],
      defaultId: 1,
      cancelId: 0,
    });
    return result.response === 1;
  });

  ipcMain.handle(
    "paseo:dialog:askWithCheckbox",
    async (event, message: string, options: AskWithCheckboxOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showMessageBox(win ?? BrowserWindow.getFocusedWindow()!, {
        type: resolveDialogType(options.kind),
        title: options.title ?? "Confirm",
        message,
        buttons: [options.cancelLabel ?? "Cancel", options.okLabel ?? "OK"],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: options.checkboxLabel,
        checkboxChecked: options.checkboxChecked ?? false,
      });
      return {
        confirmed: result.response === 1,
        dontAskAgain: result.checkboxChecked,
      };
    },
  );

  ipcMain.handle("paseo:dialog:open", async (event, options?: OpenOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const properties: Electron.OpenDialogOptions["properties"] = [];
    if (options?.directory) properties.push("openDirectory");
    if (options?.createDirectory) properties.push("createDirectory");
    if (options?.multiple) properties.push("multiSelections");
    if (!options?.directory) properties.push("openFile");

    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties,
      filters: options?.filters,
    });

    if (result.canceled) return null;
    return options?.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("paseo:dialog:openText", async (event, options?: OpenOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties: ["openFile"],
      filters: options?.filters,
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    const content = await readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
      throw new Error("Selected file is too large.");
    }
    return { fileName: basename(filePath), content };
  });

  ipcMain.handle("paseo:dialog:saveText", async (event, options: SaveTextOptions) => {
    if (Buffer.byteLength(options.content, "utf8") > MAX_TEXT_FILE_BYTES) {
      throw new Error("Backup is too large to save.");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, options.content, "utf8");
    return result.filePath;
  });
}
