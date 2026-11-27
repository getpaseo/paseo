import type { TailscaleStatus } from "@getpaseo/protocol/messages";

export type TailscaleErrorKey =
  | "devices.tailscale.turnOnError"
  | "devices.tailscale.turnOffError"
  | "devices.tailscale.statusError";

export interface TailscaleControlStateInput {
  status: TailscaleStatus | undefined;
  statusUpdatedAt: number;
  statusError: boolean;
  changePending: boolean;
  changePendingEnabled?: boolean;
  changeError: boolean;
  changeErrorEnabled?: boolean;
  refreshPending: boolean;
  refreshError: boolean;
  refreshSubmittedAt: number;
}

export interface TailscaleControlState {
  value: boolean | null;
  showSwitch: boolean;
  switchDisabled: boolean;
  showRefresh: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  showInstallLink: boolean;
  address: string | null;
  errorKey: TailscaleErrorKey | null;
}

function resolveSwitchValue(input: TailscaleControlStateInput): boolean | null {
  if (input.changePending) return input.changePendingEnabled ?? null;
  if (!input.status) return null;
  return input.status.state === "on" || input.status.state === "waiting";
}

function shouldShowRefresh(input: TailscaleControlStateInput): boolean {
  if (!input.status) {
    return input.statusError || input.refreshError || input.refreshPending;
  }
  return input.status.state === "unavailable" || input.status.state === "waiting";
}

function resolveErrorKey(input: TailscaleControlStateInput): TailscaleErrorKey | null {
  if (input.changeError) {
    return input.changeErrorEnabled
      ? "devices.tailscale.turnOnError"
      : "devices.tailscale.turnOffError";
  }
  if (input.refreshError && input.refreshSubmittedAt >= input.statusUpdatedAt) {
    return "devices.tailscale.statusError";
  }
  if (!input.refreshPending && input.statusError && !input.status) {
    return "devices.tailscale.statusError";
  }
  return null;
}

/**
 * Derives the Tailscale row's controls and error state from the host status query and the latest
 * toggle or manual refresh attempt.
 */
export function resolveTailscaleControlState(
  input: TailscaleControlStateInput,
): TailscaleControlState {
  const { status } = input;
  const value = resolveSwitchValue(input);
  const busy = input.changePending || input.refreshPending;
  const showRefresh = shouldShowRefresh(input);
  const showSwitch = Boolean(status) || !showRefresh;
  const switchDisabled =
    !status || status.state === "unavailable" || Boolean(status.lockedBy) || busy;

  return {
    value,
    showSwitch,
    switchDisabled,
    showRefresh,
    refreshing: input.refreshPending,
    refreshDisabled: busy,
    showInstallLink: status?.state === "unavailable",
    address: status?.state === "on" && value ? status.address : null,
    errorKey: resolveErrorKey(input),
  };
}
