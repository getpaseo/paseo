import { ipcMain, shell } from "electron";
import { z } from "zod";

import { copyFilePathsToClipboard } from "./copy-paths.js";

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

const RevealItemSchema = z.object({
  path: z.string().trim().min(1),
});

const CopyPathsSchema = z.object({
  paths: z.array(z.string().trim().min(1)).min(1),
});

export function registerShellHandlers(
  options: {
    ipc?: IpcHandlerRegistry;
    revealPath?: (path: string) => void;
    copyPaths?: (paths: readonly string[]) => boolean;
  } = {},
): void {
  const ipc = options.ipc ?? ipcMain;
  const revealPath = options.revealPath ?? ((targetPath) => shell.showItemInFolder(targetPath));
  const copyPaths = options.copyPaths ?? copyFilePathsToClipboard;

  ipc.handle("paseo:shell:revealItem", (_event, payload: unknown) => {
    const input = RevealItemSchema.parse(payload);
    revealPath(input.path);
  });

  ipc.handle("paseo:shell:copyPaths", (_event, payload: unknown) => {
    const input = CopyPathsSchema.parse(payload);
    return copyPaths(input.paths);
  });
}
