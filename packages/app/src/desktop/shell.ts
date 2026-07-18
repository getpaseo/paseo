import { getDesktopHost } from "@/desktop/host";

export async function revealItemInFolder(absolutePath: string): Promise<void> {
  const revealItem = getDesktopHost()?.shell?.revealItem;
  if (!revealItem) {
    throw new Error("Desktop shell bridge is unavailable");
  }
  await revealItem({ path: absolutePath });
}

export async function copyFilePathsAsFilesystemItems(absolutePaths: string[]): Promise<void> {
  const copyPaths = getDesktopHost()?.shell?.copyPaths;
  if (!copyPaths) {
    throw new Error("Desktop shell bridge is unavailable");
  }
  const ok = await copyPaths({ paths: absolutePaths });
  if (!ok) {
    throw new Error("Failed to copy filesystem items");
  }
}
