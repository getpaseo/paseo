import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export const BROWSER_TOOLS_TITLE = "Browser tools";
export const BROWSER_TOOLS_WARNING =
  "Allow agents to access and control Paseo browser tabs, including logged-in browser state. Only enable this for agents you trust.";

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
    title: BROWSER_TOOLS_TITLE,
    warning: BROWSER_TOOLS_WARNING,
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
    loadingText: input.isPending ? "Updating browser tools…" : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
