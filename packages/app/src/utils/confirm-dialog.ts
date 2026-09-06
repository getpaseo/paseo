import { Alert } from "react-native";
import {
  getDesktopHost,
  type DesktopDialogAskOptions,
  type DesktopDialogAskWithCheckboxOptions,
  type DesktopDialogBridge,
} from "@/desktop/host";
import { isNative } from "@/constants/platform";

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * A confirmation the user can choose to stop being asked. Only the desktop and VS Code bridges
 * offer a real checkbox, so native gets a third alert button instead and plain browser web —
 * where `window.confirm` is all there is — cannot offer the choice at all.
 */
export interface RememberableConfirmDialogInput extends ConfirmDialogInput {
  /** Checkbox label on desktop. */
  rememberLabel: string;
  /** Labels the extra native alert button that confirms and remembers. */
  rememberConfirmLabel: string;
}

export interface RememberableConfirmDialogResult {
  confirmed: boolean;
  /** Never true alongside `confirmed: false` — "always cancel" is not a choice worth storing. */
  remember: boolean;
}

export type ConfirmDialogAlertButtonStyle = "cancel" | "default" | "destructive";

export interface ConfirmDialogAlertButton {
  text: string;
  style: ConfirmDialogAlertButtonStyle;
  onPress: () => void;
}

export interface ConfirmDialogAlertRequest {
  title: string;
  message: string;
  buttons: ConfirmDialogAlertButton[];
  onDismiss: () => void;
}

/**
 * Everything a confirmation needs from the platform underneath it. Injected so tests drive the
 * three backends through this interface instead of standing in for React Native, the desktop
 * bridge, and `window` themselves.
 */
export interface ConfirmDialogHost {
  /** iOS and Android, where the OS alert is the only dialog available. */
  isNative: boolean;
  showAlert(request: ConfirmDialogAlertRequest): void;
  /** The Electron or VS Code bridge, or null when running outside both. */
  getDesktopDialog(): DesktopDialogBridge | null;
  /** `window.confirm`, or null where it does not exist. */
  getBrowserConfirm(): ((message: string) => boolean) | null;
  /** Web dialogs steal focus, so drop it before opening one. */
  blurActiveElement(): void;
}

export const platformConfirmDialogHost: ConfirmDialogHost = {
  isNative,

  showAlert(request: ConfirmDialogAlertRequest): void {
    Alert.alert(
      request.title,
      request.message,
      request.buttons.map((button) => ({
        text: button.text,
        style: button.style,
        onPress: button.onPress,
      })),
      {
        cancelable: true,
        onDismiss: request.onDismiss,
      },
    );
  },

  getDesktopDialog(): DesktopDialogBridge | null {
    if (isNative) {
      return null;
    }
    return getDesktopHost()?.dialog ?? null;
  },

  getBrowserConfirm(): ((message: string) => boolean) | null {
    if (isNative) {
      return null;
    }
    const browserConfirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
    return typeof browserConfirm === "function" ? browserConfirm.bind(globalThis) : null;
  },

  blurActiveElement(): void {
    if (isNative) {
      return;
    }
    const activeElement = (globalThis as { document?: Document }).document?.activeElement;
    (activeElement as HTMLElement | null)?.blur?.();
  },
};

const DECLINED: RememberableConfirmDialogResult = { confirmed: false, remember: false };

interface ConfirmButtonConfig {
  confirmLabel: string;
  cancelLabel: string;
}

function resolveButtonLabels(input: ConfirmDialogInput): ConfirmButtonConfig {
  return {
    confirmLabel: input.confirmLabel ?? "Confirm",
    cancelLabel: input.cancelLabel ?? "Cancel",
  };
}

function resolveConfirmButtonStyle(input: ConfirmDialogInput): ConfirmDialogAlertButtonStyle {
  return input.destructive ? "destructive" : "default";
}

function buildDesktopAskOptions(input: ConfirmDialogInput): DesktopDialogAskOptions {
  const labels = resolveButtonLabels(input);

  return {
    title: input.title,
    okLabel: labels.confirmLabel,
    cancelLabel: labels.cancelLabel,
    kind: input.destructive ? "warning" : "info",
  };
}

function buildDesktopAskWithCheckboxOptions(
  input: RememberableConfirmDialogInput,
): DesktopDialogAskWithCheckboxOptions {
  return {
    ...buildDesktopAskOptions(input),
    checkboxLabel: input.rememberLabel,
  };
}

function buildWebPromptMessage(input: ConfirmDialogInput): string {
  return `${input.title}\n\n${input.message}`;
}

async function showNativeConfirmDialog(
  input: ConfirmDialogInput,
  host: ConfirmDialogHost,
): Promise<boolean> {
  const labels = resolveButtonLabels(input);

  return new Promise<boolean>((resolve) => {
    host.showAlert({
      title: input.title,
      message: input.message,
      buttons: [
        { text: labels.cancelLabel, style: "cancel", onPress: () => resolve(false) },
        {
          text: labels.confirmLabel,
          style: resolveConfirmButtonStyle(input),
          onPress: () => resolve(true),
        },
      ],
      onDismiss: () => resolve(false),
    });
  });
}

async function showNativeRememberableConfirmDialog(
  input: RememberableConfirmDialogInput,
  host: ConfirmDialogHost,
): Promise<RememberableConfirmDialogResult> {
  const labels = resolveButtonLabels(input);
  const style = resolveConfirmButtonStyle(input);

  return new Promise<RememberableConfirmDialogResult>((resolve) => {
    host.showAlert({
      title: input.title,
      message: input.message,
      buttons: [
        { text: labels.cancelLabel, style: "cancel", onPress: () => resolve(DECLINED) },
        {
          text: labels.confirmLabel,
          style,
          onPress: () => resolve({ confirmed: true, remember: false }),
        },
        {
          text: input.rememberConfirmLabel,
          style,
          onPress: () => resolve({ confirmed: true, remember: true }),
        },
      ],
      onDismiss: () => resolve(DECLINED),
    });
  });
}

async function showDesktopConfirmDialog(
  input: ConfirmDialogInput,
  host: ConfirmDialogHost,
): Promise<boolean | null> {
  const desktopAsk = host.getDesktopDialog()?.ask;
  if (typeof desktopAsk !== "function") {
    return null;
  }

  host.blurActiveElement();
  return await desktopAsk(input.message, buildDesktopAskOptions(input));
}

async function showDesktopRememberableConfirmDialog(
  input: RememberableConfirmDialogInput,
  host: ConfirmDialogHost,
): Promise<RememberableConfirmDialogResult | null> {
  const desktopAskWithCheckbox = host.getDesktopDialog()?.askWithCheckbox;
  if (typeof desktopAskWithCheckbox !== "function") {
    return null;
  }

  host.blurActiveElement();
  const result = await desktopAskWithCheckbox(
    input.message,
    buildDesktopAskWithCheckboxOptions(input),
  );
  return {
    confirmed: result.confirmed,
    remember: result.confirmed && result.dontAskAgain,
  };
}

function showWebConfirmDialog(input: ConfirmDialogInput, host: ConfirmDialogHost): boolean {
  const browserConfirm = host.getBrowserConfirm();
  if (!browserConfirm) {
    throw new Error("[ConfirmDialog] No web confirmation backend is available.");
  }

  host.blurActiveElement();
  return browserConfirm(buildWebPromptMessage(input));
}

export async function confirmDialog(
  input: ConfirmDialogInput,
  host: ConfirmDialogHost = platformConfirmDialogHost,
): Promise<boolean> {
  if (host.isNative) {
    return showNativeConfirmDialog(input, host);
  }

  const desktopResult = await showDesktopConfirmDialog(input, host);
  if (desktopResult !== null) {
    return desktopResult;
  }

  return showWebConfirmDialog(input, host);
}

/**
 * Like {@link confirmDialog}, plus a way for the user to say they do not want to be asked again.
 * A host that cannot offer the choice still confirms; it just always reports `remember: false`.
 */
export async function confirmDialogWithRemember(
  input: RememberableConfirmDialogInput,
  host: ConfirmDialogHost = platformConfirmDialogHost,
): Promise<RememberableConfirmDialogResult> {
  if (host.isNative) {
    return showNativeRememberableConfirmDialog(input, host);
  }

  const desktopResult = await showDesktopRememberableConfirmDialog(input, host);
  if (desktopResult !== null) {
    return desktopResult;
  }

  return { confirmed: await confirmDialog(input, host), remember: false };
}
