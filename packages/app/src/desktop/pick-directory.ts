import { getDesktopHost, type DesktopDialogBridge } from "./host";

export async function pickDirectory({
  defaultPath,
  dialog = getDesktopHost()?.dialog ?? null,
}: {
  defaultPath?: string | null;
  dialog?: DesktopDialogBridge | null;
} = {}): Promise<string | null> {
  const open = dialog?.open;
  if (typeof open !== "function") {
    throw new Error("Desktop dialog open() is unavailable in this environment.");
  }

  const selection = await open({
    directory: true,
    multiple: false,
    createDirectory: true,
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (selection === null) {
    return null;
  }
  if (typeof selection === "string") {
    return selection;
  }

  throw new Error("Unexpected directory picker response.");
}
