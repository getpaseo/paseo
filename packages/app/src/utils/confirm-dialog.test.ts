import { afterEach, describe, expect, it, vi } from "vitest";

const desktopHostState = {
  api: null as {
    dialog?: {
      ask?: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
    };
  } | null,
};

type MockPlatform = "web" | "ios" | "android";

type AlertButton = {
  onPress?: () => void;
};

async function loadModuleForPlatform(platform: MockPlatform): Promise<{
  confirmDialog: typeof import("./confirm-dialog").confirmDialog;
  alertMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const alertMock = vi.fn();
  vi.doMock("react-native", () => ({
    Alert: {
      alert: alertMock,
    },
    Platform: { OS: platform },
  }));
  vi.doMock("@/desktop/host", () => ({
    getDesktopHost: () => desktopHostState.api,
  }));

  const module = await import("./confirm-dialog");
  return { confirmDialog: module.confirmDialog, alertMock };
}

function clearDialogGlobals(): void {
  desktopHostState.api = null;
  delete (globalThis as { confirm?: unknown }).confirm;
}

describe("confirmDialog", () => {
  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    clearDialogGlobals();
  });

  it("uses the desktop dialog bridge on web when available", async () => {
    const askMock = vi.fn(async () => true);
    const blurMock = vi.fn();
    (globalThis as { document?: unknown }).document = {
      activeElement: { blur: blurMock },
    } as unknown as Document;
    desktopHostState.api = {
      dialog: { ask: askMock },
    };

    const { confirmDialog, alertMock } = await loadModuleForPlatform("web");
    const confirmed = await confirmDialog({
      title: "Restart host",
      message: "This will restart the daemon.",
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    });

    expect(confirmed).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
    expect(blurMock).toHaveBeenCalledTimes(1);
    expect(askMock).toHaveBeenCalledWith("This will restart the daemon.", {
      title: "Restart host",
      okLabel: "Restart",
      cancelLabel: "Cancel",
      kind: "warning",
    });
  });

  it("falls back to browser confirm on web when desktop APIs are unavailable", async () => {
    const browserConfirm = vi.fn(() => true);
    const blurMock = vi.fn();
    (globalThis as { document?: unknown }).document = {
      activeElement: { blur: blurMock },
    } as unknown as Document;
    (globalThis as { confirm?: unknown }).confirm = browserConfirm;

    const { confirmDialog } = await loadModuleForPlatform("web");
    const confirmed = await confirmDialog({
      title: "Restart host",
      message: "This will restart the daemon.",
    });

    expect(confirmed).toBe(true);
    expect(blurMock).toHaveBeenCalledTimes(1);
    expect(browserConfirm).toHaveBeenCalledWith("Restart host\n\nThis will restart the daemon.");
  });

  it("throws on web when no confirm backend exists", async () => {
    const { confirmDialog } = await loadModuleForPlatform("web");

    await expect(
      confirmDialog({
        title: "Restart host",
        message: "This will restart the daemon.",
      }),
    ).rejects.toThrow("[ConfirmDialog] No web confirmation backend is available.");
  });

  it("uses native Alert on iOS/Android", async () => {
    const { confirmDialog, alertMock } = await loadModuleForPlatform("ios");
    alertMock.mockImplementation((_title: string, _message: string, buttons?: AlertButton[]) => {
      const confirmButton = buttons?.[1];
      confirmButton?.onPress?.();
    });

    const confirmed = await confirmDialog({
      title: "Restart host",
      message: "This will restart the daemon.",
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    });

    expect(confirmed).toBe(true);
    expect(alertMock).toHaveBeenCalled();
  });
});
