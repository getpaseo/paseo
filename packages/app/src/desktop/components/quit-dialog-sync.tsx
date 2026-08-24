import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * Pushes the translated quit-dialog strings to the main process. Renders
 * nothing; mounted once from the root layout.
 *
 * The quit dialog is a native message box shown from main, which has no i18n
 * bundle. Main caches what it receives here, so the quit path never has to reach
 * back into the renderer or touch disk at the moment the user is quitting.
 */
export function QuitDialogSync(): null {
  const { i18n } = useTranslation();
  // Depend on the resolved language, never on `t`: its identity changes on
  // every render, which would re-push the copy over IPC continuously.
  const language = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }

    void invokeDesktopCommand("set_quit_dialog_copy", {
      title: i18n.t("desktop.quitConfirm.title"),
      message: i18n.t("desktop.quitConfirm.message"),
      quitLabel: i18n.t("desktop.quitConfirm.quit"),
      cancelLabel: i18n.t("desktop.quitConfirm.cancel"),
      keepDaemonRunningLabel: i18n.t("desktop.quitConfirm.keepDaemonRunning"),
    }).catch((error: unknown) => {
      // Non-fatal: main keeps whatever copy it already has, falling back to
      // its English constants. A failed push must never break the app, but it
      // must not be invisible either — an English dialog on a translated app is
      // otherwise impossible to explain.
      console.warn("[quit-dialog-sync] Failed to push quit dialog copy", error);
    });
  }, [i18n, language]);

  return null;
}
