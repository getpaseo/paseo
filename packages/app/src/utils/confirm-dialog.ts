import { Alert, Platform } from "react-native";
import { getTauri, type TauriDialogAskOptions } from "@/utils/tauri";

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

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
      }
    );
  });
}

function getTauriApi() {
  if (Platform.OS !== "web") {
    return null;
  }
  return getTauri();
}

function buildTauriAskOptions(input: ConfirmDialogInput): TauriDialogAskOptions {
  const labels = resolveButtonLabels(input);

  return {
    title: input.title,
    okLabel: labels.confirmLabel,
    cancelLabel: labels.cancelLabel,
    kind: input.destructive ? "warning" : "info",
  };
}

async function showTauriConfirmDialog(input: ConfirmDialogInput): Promise<boolean | null> {
  const tauriApi = getTauriApi();
  if (!tauriApi) {
    return null;
  }

  const options = buildTauriAskOptions(input);
  const tauriAsk = tauriApi.dialog?.ask;

  if (typeof tauriAsk === "function") {
    try {
      return Boolean(await tauriAsk(input.message, options));
    } catch (error) {
      console.warn("[ConfirmDialog] Tauri dialog.ask failed", error);
    }
  }

  const tauriInvoke = tauriApi.core?.invoke;
  if (typeof tauriInvoke === "function") {
    try {
      const result = await tauriInvoke("plugin:dialog|ask", {
        message: input.message,
        ...options,
      });
      return result === true;
    } catch (error) {
      console.warn("[ConfirmDialog] Tauri plugin:dialog|ask failed", error);
    }
  }

  return null;
}

function showWebConfirmDialog(input: ConfirmDialogInput): boolean {
  const browserConfirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (typeof browserConfirm !== "function") {
    throw new Error("[ConfirmDialog] No web confirmation backend is available.");
  }

  const promptMessage = `${input.title}\n\n${input.message}`;
  return browserConfirm(promptMessage);
}

export async function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  if (Platform.OS !== "web") {
    return showNativeConfirmDialog(input);
  }

  const tauriResult = await showTauriConfirmDialog(input);
  if (tauriResult !== null) {
    return tauriResult;
  }

  return showWebConfirmDialog(input);
}
