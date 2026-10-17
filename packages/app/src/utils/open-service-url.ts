import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  loadAppSettingsFromStorage,
  persistAppSettings,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { openExternalUrl } from "@/utils/open-external-url";

/** Where an in-app service URL lands: the focused pane, or the side pane beside the user's work. */
export type ServiceUrlInAppLocation = "focused" | "side";
export type ServiceUrlAskResult = "in-app" | "external";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string, location: ServiceUrlInAppLocation) => void;
}

export interface RouteServiceUrlInput {
  url: string;
  behavior: ServiceUrlBehavior;
  askHowToOpen(): Promise<ServiceUrlAskResult>;
  openInApp(url: string, location: ServiceUrlInAppLocation): void;
  openExternal(url: string): Promise<void>;
}

export async function routeServiceUrl(input: RouteServiceUrlInput): Promise<void> {
  const behavior = input.behavior === "ask" ? await input.askHowToOpen() : input.behavior;
  if (behavior === "external") {
    await input.openExternal(input.url);
    return;
  }
  input.openInApp(input.url, behavior === "in-app-side" ? "side" : "focused");
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const openInApp = options?.openInApp;
  if (!openInApp || !isElectronRuntime()) {
    await openExternalUrl(url);
    return;
  }

  const settings = await loadAppSettingsFromStorage();
  await routeServiceUrl({
    url,
    behavior: settings.serviceUrlBehavior,
    askHowToOpen: () => askHowToOpen(url),
    openInApp,
    openExternal: openExternalUrl,
  });
}

async function askHowToOpen(url: string): Promise<ServiceUrlAskResult> {
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

  const choice: ServiceUrlAskResult = result.confirmed ? "in-app" : "external";
  if (result.dontAskAgain) {
    await persistAppSettings({ serviceUrlBehavior: choice });
  }
  return choice;
}
