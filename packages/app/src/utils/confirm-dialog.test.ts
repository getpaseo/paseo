import { afterEach, describe, expect, it, vi } from "vitest";

const desktopHostState = {
  api: null as {
    dialog?: {
      ask?: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
    };
  } | null,
};

type MockPlatform = "web" | "ios" | "android";

interface AlertButton {
  onPress?: () => void;
}

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

  it("shows the in-app confirm dialog on web when desktop APIs are unavailable", async () => {
    const browserConfirm = vi.fn(() => true);
    const blurMock = vi.fn();
    (globalThis as { document?: unknown }).document = {
      activeElement: { blur: blurMock },
    } as unknown as Document;
    (globalThis as { confirm?: unknown }).confirm = browserConfirm;

    const { confirmDialog } = await loadModuleForPlatform("web");
    const { useConfirmDialogStore } = await import("./confirm-dialog-store");
    const result = confirmDialog({
      title: "Archive workspace",
      message: "Archive this workspace?",
      destructive: true,
    });

    await vi.waitFor(() => expect(useConfirmDialogStore.getState().pending).not.toBeNull());
    const pending = useConfirmDialogStore.getState().pending;
    expect(pending?.input).toEqual({
      title: "Archive workspace",
      message: "Archive this workspace?",
      destructive: true,
    });
    useConfirmDialogStore.getState().answer(pending?.id ?? -1, true);

    await expect(result).resolves.toBe(true);
    expect(useConfirmDialogStore.getState().pending).toBeNull();
    expect(blurMock).toHaveBeenCalledTimes(1);
    expect(browserConfirm).not.toHaveBeenCalled();
  });

  it("cancels an on-screen confirm when a newer one replaces it", async () => {
    const { confirmDialog } = await loadModuleForPlatform("web");
    const { useConfirmDialogStore } = await import("./confirm-dialog-store");
    const first = confirmDialog({ title: "First", message: "First?" });
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().pending).not.toBeNull());
    const second = confirmDialog({ title: "Second", message: "Second?" });

    await expect(first).resolves.toBe(false);
    await vi.waitFor(() =>
      expect(useConfirmDialogStore.getState().pending?.input.title).toBe("Second"),
    );
    const replacement = useConfirmDialogStore.getState().pending;
    useConfirmDialogStore.getState().answer(replacement?.id ?? -1, false);
    await expect(second).resolves.toBe(false);
  });

  it("ignores an answer meant for a confirmation that was already replaced", async () => {
    const { confirmDialog } = await loadModuleForPlatform("web");
    const { useConfirmDialogStore } = await import("./confirm-dialog-store");
    const first = confirmDialog({ title: "First", message: "First?" });
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().pending).not.toBeNull());
    const replacedId = useConfirmDialogStore.getState().pending?.id ?? -1;
    const second = confirmDialog({ title: "Second", message: "Second?" });
    await expect(first).resolves.toBe(false);

    // The first sheet finishing its dismissal must not cancel the second.
    useConfirmDialogStore.getState().answer(replacedId, false);
    expect(useConfirmDialogStore.getState().pending?.input.title).toBe("Second");

    const current = useConfirmDialogStore.getState().pending;
    useConfirmDialogStore.getState().answer(current?.id ?? -1, true);
    await expect(second).resolves.toBe(true);
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
