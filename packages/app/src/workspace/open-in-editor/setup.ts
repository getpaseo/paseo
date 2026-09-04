import type { TFunction } from "i18next";
import type { ToastApi } from "@/components/toast-host";

/**
 * The toast has no dismiss control and `durationMs: null` schedules no timer at all, so a
 * pinned toast would sit there for the rest of the session. This is long enough to read an
 * instruction and act on it; hovering the toast on web pauses the countdown.
 */
export const REMOTE_HOST_SETUP_TOAST_MS = 8_000;

interface RemoteHostSetupInput {
  serverId: string;
  hostLabel: string;
  toast: Pick<ToastApi, "show">;
  t: TFunction;
  /** Injected so this module stays free of the router, and the ordering stays testable. */
  navigate: (serverId: string) => void;
}

/**
 * Landing on host settings is not enough — it is a page full of settings — so name the host
 * and the setting once the route has changed. This is information, not a failure: the user
 * asked for something this client cannot do until the SSH host is filled in.
 */
export function startRemoteHostEditorSetup(input: RemoteHostSetupInput): void {
  input.navigate(input.serverId);
  input.toast.show(input.t("workspace.git.openInEditor.setUpToast", { host: input.hostLabel }), {
    variant: "info",
    durationMs: REMOTE_HOST_SETUP_TOAST_MS,
  });
}
