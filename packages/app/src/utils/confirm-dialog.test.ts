import { afterEach, describe, expect, it, vi } from "vitest";

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

  const module = await import("./confirm-dialog");
  return { confirmDialog: module.confirmDialog, alertMock };
}

function clearDialogGlobals(): void {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  delete (globalThis as { confirm?: unknown }).confirm;
}

describe("confirmDialog", () => {
  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    clearDialogGlobals();
  });

  it("uses Tauri dialog.ask on web when available", async () => {
    const askMock = vi.fn(async () => true);
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
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
    expect(askMock).toHaveBeenCalledWith("This will restart the daemon.", {
      title: "Restart host",
      okLabel: "Restart",
      cancelLabel: "Cancel",
      kind: "warning",
    });
  });

  it("falls back to browser confirm on web when Tauri APIs are unavailable", async () => {
    const browserConfirm = vi.fn(() => true);
    (globalThis as { confirm?: unknown }).confirm = browserConfirm;

    const { confirmDialog } = await loadModuleForPlatform("web");
    const confirmed = await confirmDialog({
      title: "Restart host",
      message: "This will restart the daemon.",
    });

    expect(confirmed).toBe(true);
    expect(browserConfirm).toHaveBeenCalledWith(
      "Restart host\n\nThis will restart the daemon."
    );
  });

  it("throws on web when no confirm backend exists", async () => {
    const { confirmDialog } = await loadModuleForPlatform("web");

    await expect(
      confirmDialog({
        title: "Restart host",
        message: "This will restart the daemon.",
      })
    ).rejects.toThrow("[ConfirmDialog] No web confirmation backend is available.");
  });

  it("uses native Alert on iOS/Android", async () => {
    const { confirmDialog, alertMock } = await loadModuleForPlatform("ios");
    alertMock.mockImplementation(
      (
        _title: string,
        _message: string,
        buttons?: AlertButton[]
      ) => {
        const confirmButton = buttons?.[1];
        confirmButton?.onPress?.();
      }
    );

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
