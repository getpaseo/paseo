import { Alert } from "react-native";
import {
  getDesktopHost,
  type DesktopDialogAskOptions,
  type DesktopDialogAskWithCheckboxOptions,
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
 * offer a real checkbox, so native gets a third Alert button instead and plain browser web —
 * where `window.confirm` is all there is — cannot offer the choice at all.
 */
export interface RememberableConfirmDialogInput extends ConfirmDialogInput {
  /** Checkbox label on desktop. */
  rememberLabel: string;
  /** Labels the extra native Alert button that confirms and remembers. */
  rememberConfirmLabel: string;
}

export interface RememberableConfirmDialogResult {
  confirmed: boolean;
  /** Never true alongside `confirmed: false` — "always cancel" is not a choice worth storing. */
  remember: boolean;
}

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

async function showNativeConfirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  const labels = resolveButtonLabels(input);

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        {
          text: labels.cancelLabel,
          style: "cancel",
          onPress: () => resolve(false),
        },
        {
          text: labels.confirmLabel,
          style: input.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      {
        cancelable: true,
        onDismiss: () => resolve(false),
      },
    );
  });
}

async function showNativeRememberableConfirmDialog(
  input: RememberableConfirmDialogInput,
): Promise<RememberableConfirmDialogResult> {
  const labels = resolveButtonLabels(input);
  const style = input.destructive ? "destructive" : "default";

  return new Promise<RememberableConfirmDialogResult>((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        {
          text: labels.cancelLabel,
          style: "cancel",
          onPress: () => resolve(DECLINED),
        },
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
      {
        cancelable: true,
        onDismiss: () => resolve(DECLINED),
      },
    );
  });
}

function getDesktopApi() {
  if (isNative) {
    return null;
  }
  return getDesktopHost();
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

function blurActiveWebElement(): void {
  if (isNative) {
    return;
  }
  const activeElement = (globalThis as { document?: Document }).document?.activeElement;
  (activeElement as HTMLElement | null)?.blur?.();
}

async function showDesktopConfirmDialog(input: ConfirmDialogInput): Promise<boolean | null> {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    return null;
  }

  blurActiveWebElement();
  const options = buildDesktopAskOptions(input);
  const desktopAsk = desktopApi.dialog?.ask;

  if (typeof desktopAsk === "function") {
    return await desktopAsk(input.message, options);
  }

  return null;
}

function buildDesktopAskWithCheckboxOptions(
  input: RememberableConfirmDialogInput,
): DesktopDialogAskWithCheckboxOptions {
  return {
    ...buildDesktopAskOptions(input),
    checkboxLabel: input.rememberLabel,
  };
}

async function showDesktopRememberableConfirmDialog(
  input: RememberableConfirmDialogInput,
): Promise<RememberableConfirmDialogResult | null> {
  const desktopAskWithCheckbox = getDesktopApi()?.dialog?.askWithCheckbox;
  if (typeof desktopAskWithCheckbox !== "function") {
    return null;
  }

  blurActiveWebElement();
  const result = await desktopAskWithCheckbox(
    input.message,
    buildDesktopAskWithCheckboxOptions(input),
  );
  return {
    confirmed: result.confirmed,
    remember: result.confirmed && result.dontAskAgain,
  };
}

function showWebConfirmDialog(input: ConfirmDialogInput): boolean {
  const browserConfirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (typeof browserConfirm !== "function") {
    throw new Error("[ConfirmDialog] No web confirmation backend is available.");
  }

  blurActiveWebElement();
  const promptMessage = `${input.title}\n\n${input.message}`;
  return browserConfirm(promptMessage);
}

export async function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  if (isNative) {
    return showNativeConfirmDialog(input);
  }

  const desktopResult = await showDesktopConfirmDialog(input);
  if (desktopResult !== null) {
    return desktopResult;
  }

  return showWebConfirmDialog(input);
}

/**
 * Like {@link confirmDialog}, plus a way for the user to say they do not want to be asked again.
 * A host that cannot offer the choice still confirms; it just always reports `remember: false`.
 */
export async function confirmDialogWithRemember(
  input: RememberableConfirmDialogInput,
): Promise<RememberableConfirmDialogResult> {
  if (isNative) {
    return showNativeRememberableConfirmDialog(input);
  }

  const desktopResult = await showDesktopRememberableConfirmDialog(input);
  if (desktopResult !== null) {
    return desktopResult;
  }

  return { confirmed: await confirmDialog(input), remember: false };
}

export const __private__ = {
  blurActiveWebElement,
  buildDesktopAskOptions,
  buildDesktopAskWithCheckboxOptions,
};
