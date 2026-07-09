import { getDesktopHost, type DesktopDialogBridge } from "./host";

export async function pickDirectoryWithDesktopDialog(
  dialog: DesktopDialogBridge | null,
): Promise<string | null> {
  const open = dialog?.open;
  if (typeof open !== "function") {
    throw new Error("Desktop dialog open() is unavailable in this environment.");
  }

  const selection = await open({
    directory: true,
    multiple: false,
  });
  if (selection === null) {
    return null;
  }
  if (typeof selection === "string") {
    return selection;
  }

  throw new Error("Unexpected directory picker response.");
}

export async function pickDirectory(): Promise<string | null> {
  return pickDirectoryWithDesktopDialog(getDesktopHost()?.dialog ?? null);
}
