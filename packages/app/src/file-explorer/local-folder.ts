import type { LocalFolder } from "./copy-folder";

// Native apps cannot write a folder tree into a place the user picks; see local-folder.web.ts.
export function canSaveFolders(): boolean {
  return false;
}

export async function pickLocalFolder(): Promise<LocalFolder | null> {
  throw new Error("Saving folders is not supported on this platform.");
}
