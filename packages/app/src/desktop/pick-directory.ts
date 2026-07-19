import { getDesktopHost, type DesktopDialogBridge } from "./host";

export async function pickDirectory(
  dialog: DesktopDialogBridge | null = getDesktopHost()?.dialog ?? null,
): Promise<string | null> {
  const open = dialog?.open;
  if (typeof open !== "function") {
    throw new Error("Desktop dialog open() is unavailable in this environment.");
  }

  const selection = await open({
    directory: true,
    multiple: false,
    createDirectory: true,
  });
  if (selection === null) {
    return null;
  }
  if (typeof selection === "string") {
    return selection;
  }

  throw new Error("Unexpected directory picker response.");
}
