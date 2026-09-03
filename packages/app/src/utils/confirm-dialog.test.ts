import { afterEach, describe, expect, it, vi } from "vitest";

const desktopHostState = {
  api: null as {
    dialog?: {
      ask?: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
      askWithCheckbox?: (
        message: string,
        options: Record<string, unknown>,
      ) => Promise<{ confirmed: boolean; dontAskAgain: boolean }>;
    };
  } | null,
};

type MockPlatform = "web" | "ios" | "android";

interface AlertButton {
  text?: string;
  onPress?: () => void;
}

async function loadModuleForPlatform(platform: MockPlatform): Promise<{
  confirmDialog: typeof import("./confirm-dialog").confirmDialog;
  confirmDialogWithRemember: typeof import("./confirm-dialog").confirmDialogWithRemember;
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
  return {
    confirmDialog: module.confirmDialog,
    confirmDialogWithRemember: module.confirmDialogWithRemember,
    alertMock,
  };
}

function pressAlertButton(buttons: AlertButton[] | undefined, label: string): void {
  for (const button of buttons ?? []) {
    if (button.text === label) {
      button.onPress?.();
      return;
    }
  }
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

describe("confirmDialogWithRemember", () => {
  const input = {
    title: "Close terminal?",
    message: "Any running process in this terminal will be stopped immediately.",
    confirmLabel: "Close",
    cancelLabel: "Cancel",
    rememberLabel: "Remember this choice",
    rememberConfirmLabel: "Close and don't ask again",
    destructive: true,
  };

  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    clearDialogGlobals();
  });

  it("reports the checkbox from the desktop dialog", async () => {
    const askWithCheckbox = vi.fn(async () => ({ confirmed: true, dontAskAgain: true }));
    desktopHostState.api = { dialog: { askWithCheckbox } };

    const { confirmDialogWithRemember } = await loadModuleForPlatform("web");

    await expect(confirmDialogWithRemember(input)).resolves.toEqual({
      confirmed: true,
      remember: true,
    });
    expect(askWithCheckbox).toHaveBeenCalledWith(
      "Any running process in this terminal will be stopped immediately.",
      {
        title: "Close terminal?",
        okLabel: "Close",
        cancelLabel: "Cancel",
        kind: "warning",
        checkboxLabel: "Remember this choice",
      },
    );
  });

  it("never remembers a cancelled desktop dialog", async () => {
    desktopHostState.api = {
      dialog: { askWithCheckbox: async () => ({ confirmed: false, dontAskAgain: true }) },
    };

    const { confirmDialogWithRemember } = await loadModuleForPlatform("web");

    await expect(confirmDialogWithRemember(input)).resolves.toEqual({
      confirmed: false,
      remember: false,
    });
  });

  it("falls back to the plain desktop dialog when the checkbox bridge is missing", async () => {
    const ask = vi.fn(async () => true);
    desktopHostState.api = { dialog: { ask } };

    const { confirmDialogWithRemember } = await loadModuleForPlatform("web");

    await expect(confirmDialogWithRemember(input)).resolves.toEqual({
      confirmed: true,
      remember: false,
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("falls back to browser confirm with no way to remember", async () => {
    (globalThis as { confirm?: unknown }).confirm = vi.fn(() => true);

    const { confirmDialogWithRemember } = await loadModuleForPlatform("web");

    await expect(confirmDialogWithRemember(input)).resolves.toEqual({
      confirmed: true,
      remember: false,
    });
  });

  it.each([
    ["Cancel", { confirmed: false, remember: false }],
    ["Close", { confirmed: true, remember: false }],
    ["Close and don't ask again", { confirmed: true, remember: true }],
  ])("maps the native %s button", async (label, expected) => {
    const { confirmDialogWithRemember, alertMock } = await loadModuleForPlatform("ios");
    alertMock.mockImplementation((_title: string, _message: string, buttons?: AlertButton[]) => {
      pressAlertButton(buttons, label);
    });

    await expect(confirmDialogWithRemember(input)).resolves.toEqual(expected);
  });

  it("declines when the native alert is dismissed", async () => {
    const { confirmDialogWithRemember, alertMock } = await loadModuleForPlatform("ios");
    alertMock.mockImplementation(
      (
        _title: string,
        _message: string,
        _buttons?: AlertButton[],
        options?: { onDismiss?: () => void },
      ) => {
        options?.onDismiss?.();
      },
    );

    await expect(confirmDialogWithRemember(input)).resolves.toEqual({
      confirmed: false,
      remember: false,
    });
  });
});
