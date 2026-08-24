import { dialog, ipcMain, BrowserWindow } from "electron";

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

function resolveDialogType(kind: AskOptions["kind"]): "warning" | "error" | "question" {
  if (kind === "warning") return "warning";
  if (kind === "error") return "error";
  return "question";
}

/**
 * Index of the confirming button in the `buttons` array built below. Cancel is
 * always index 0 so that Escape and a closed dialog both read as "not confirmed".
 */
export const CONFIRM_BUTTON_INDEX = 1;
const CANCEL_BUTTON_INDEX = 0;

export interface ConfirmMessageBoxOptions extends AskOptions {
  message: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  /**
   * Which button Enter activates. Defaults to "ok" to match every dialog that
   * predates this option. Dialogs guarding a destructive action must pass
   * "cancel" — otherwise the reflex keypress after a mis-triggered action
   * confirms the very thing the dialog exists to catch.
   */
  defaultButton?: "ok" | "cancel";
}

/**
 * Single source of truth for the confirm-dialog button contract. The button
 * order decides what Enter and Escape do, so it lives in one place rather than
 * being restated at each call site.
 */
export function buildConfirmMessageBoxOptions(
  options: ConfirmMessageBoxOptions,
): Electron.MessageBoxOptions {
  const built: Electron.MessageBoxOptions = {
    type: resolveDialogType(options.kind),
    title: options.title ?? "Confirm",
    message: options.message,
    buttons: [options.cancelLabel ?? "Cancel", options.okLabel ?? "OK"],
    defaultId: options.defaultButton === "cancel" ? CANCEL_BUTTON_INDEX : CONFIRM_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
  };
  if (options.checkboxLabel !== undefined) {
    built.checkboxLabel = options.checkboxLabel;
    built.checkboxChecked = options.checkboxChecked ?? false;
  }
  return built;
}

export function registerDialogHandlers(): void {
  ipcMain.handle("paseo:dialog:ask", async (event, message: string, options?: AskOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showMessageBox(
      win ?? BrowserWindow.getFocusedWindow()!,
      buildConfirmMessageBoxOptions({ ...options, message }),
    );
    return result.response === CONFIRM_BUTTON_INDEX;
  });

  ipcMain.handle(
    "paseo:dialog:askWithCheckbox",
    async (event, message: string, options: AskWithCheckboxOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showMessageBox(
        win ?? BrowserWindow.getFocusedWindow()!,
        buildConfirmMessageBoxOptions({ ...options, message }),
      );
      return {
        confirmed: result.response === CONFIRM_BUTTON_INDEX,
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
}
