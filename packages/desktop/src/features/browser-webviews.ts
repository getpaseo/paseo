import type { WebContents } from "electron";

const browserIdsByWebContentsId = new Map<number, string>();

export function registerPaseoBrowserWebContents(contents: WebContents, browserId: string): void {
  browserIdsByWebContentsId.set(contents.id, browserId);
  contents.once("destroyed", () => {
    browserIdsByWebContentsId.delete(contents.id);
  });
}

export function getPaseoBrowserIdForWebContents(contents: WebContents | null): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserIdsByWebContentsId.get(contents.id) ?? null;
}
