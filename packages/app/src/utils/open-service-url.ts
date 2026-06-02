import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  loadAppSettingsFromStorage,
  persistAppSettings,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { openExternalUrl } from "@/utils/open-external-url";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string) => void;
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const openInApp = options?.openInApp;
  if (!openInApp || !isElectronRuntime()) {
    await openExternalUrl(url);
    return;
  }

  const behavior = await resolveBehavior(url);
  if (behavior === "in-app") {
    openInApp(url);
    return;
  }
  await openExternalUrl(url);
}

async function resolveBehavior(url: string): Promise<Exclude<ServiceUrlBehavior, "ask">> {
  const settings = await loadAppSettingsFromStorage();
  if (settings.serviceUrlBehavior === "in-app" || settings.serviceUrlBehavior === "external") {
    return settings.serviceUrlBehavior;
  }

  const askWithCheckbox = getDesktopHost()?.dialog?.askWithCheckbox;
  if (typeof askWithCheckbox !== "function") {
    return "external";
  }

  const result = await askWithCheckbox(i18n.t("serviceUrl.message", { url }), {
    title: i18n.t("serviceUrl.title"),
    okLabel: i18n.t("serviceUrl.inPaseo"),
    cancelLabel: i18n.t("serviceUrl.externalBrowser"),
    checkboxLabel: i18n.t("serviceUrl.dontAskAgain"),
  });

  const choice: Exclude<ServiceUrlBehavior, "ask"> = result.confirmed ? "in-app" : "external";
  if (result.dontAskAgain) {
    await persistAppSettings({ serviceUrlBehavior: choice });
  }
  return choice;
}
