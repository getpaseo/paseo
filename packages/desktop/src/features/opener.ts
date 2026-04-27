import { shell, ipcMain } from "electron";

export function registerOpenerHandlers(): void {
  ipcMain.handle("hubcode:opener:openUrl", async (_event, url: string) => {
    await shell.openExternal(url);
  });
}
