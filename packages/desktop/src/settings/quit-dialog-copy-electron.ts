import { app } from "electron";

import { createQuitDialogCopyStore, type QuitDialogCopyStore } from "./quit-dialog-copy.js";

let quitDialogCopyStore: QuitDialogCopyStore | null = null;

export function getQuitDialogCopyStore(): QuitDialogCopyStore {
  quitDialogCopyStore ??= createQuitDialogCopyStore({
    userDataPath: app.getPath("userData"),
  });
  return quitDialogCopyStore;
}
