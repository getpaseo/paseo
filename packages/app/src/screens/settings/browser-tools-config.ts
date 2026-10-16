import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

export interface BrowserToolsCardState {
  isVisible: boolean;
  isEnabled: boolean;
  title: string;
  warning: string;
}

export interface BrowserToolsMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

export function getBrowserToolsCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): BrowserToolsCardState {
  return {
    isVisible: input.isConnected,
    isEnabled: input.config?.browserTools.enabled === true,
    title: i18n.t("settings.host.browserTools.title"),
    warning: i18n.t("settings.host.browserTools.warning"),
  };
}

export function createBrowserToolsPatch(enabled: boolean): Partial<MutableDaemonConfig> {
  return { browserTools: { enabled } };
}

export function getBrowserToolsMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): BrowserToolsMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? i18n.t("settings.host.browserTools.updating") : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
