import { describe, expect, it } from "vitest";
import { confirmDialog, confirmDialogWithRemember } from "./confirm-dialog";
import { createFakeConfirmDialogHost } from "./confirm-dialog.fakes";

const RESTART_HOST = {
  title: "Restart host",
  message: "This will restart the daemon.",
  confirmLabel: "Restart",
  cancelLabel: "Cancel",
  destructive: true,
};

const CLOSE_TERMINAL = {
  title: "Close terminal?",
  message: "Any running process in this terminal will be stopped immediately.",
  confirmLabel: "Close",
  cancelLabel: "Cancel",
  rememberLabel: "Remember this choice",
  rememberConfirmLabel: "Close and don't ask again",
  destructive: true,
};

describe("confirmDialog", () => {
  it("asks the desktop dialog and drops focus first", async () => {
    const host = createFakeConfirmDialogHost({ desktopAsk: () => true });

    await expect(confirmDialog(RESTART_HOST, host)).resolves.toBe(true);
    expect(host.desktopAsks).toEqual([
      {
        message: "This will restart the daemon.",
        options: {
          title: "Restart host",
          okLabel: "Restart",
          cancelLabel: "Cancel",
          kind: "warning",
        },
      },
    ]);
    expect(host.blurCount()).toBe(1);
    expect(host.alerts).toEqual([]);
  });

  it("falls back to browser confirm when no desktop bridge exists", async () => {
    const host = createFakeConfirmDialogHost({ browserConfirm: () => true });

    await expect(confirmDialog(RESTART_HOST, host)).resolves.toBe(true);
    expect(host.browserPrompts).toEqual(["Restart host\n\nThis will restart the daemon."]);
    expect(host.blurCount()).toBe(1);
  });

  it("throws when no web confirmation backend is available", async () => {
    const host = createFakeConfirmDialogHost();

    await expect(confirmDialog(RESTART_HOST, host)).rejects.toThrow(
      "[ConfirmDialog] No web confirmation backend is available.",
    );
  });

  it("uses a two-button alert on native", async () => {
    const host = createFakeConfirmDialogHost({ isNative: true, pressAlertButton: "Restart" });

    await expect(confirmDialog(RESTART_HOST, host)).resolves.toBe(true);
    expect(host.lastAlertButtons()).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Restart", style: "destructive" },
    ]);
    expect(host.desktopAsks).toEqual([]);
  });
});

describe("confirmDialogWithRemember", () => {
  it("reports the checkbox from the desktop dialog", async () => {
    const host = createFakeConfirmDialogHost({
      desktopAskWithCheckbox: () => ({ confirmed: true, dontAskAgain: true }),
    });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual({
      confirmed: true,
      remember: true,
    });
    expect(host.desktopAsksWithCheckbox).toEqual([
      {
        message: "Any running process in this terminal will be stopped immediately.",
        options: {
          title: "Close terminal?",
          okLabel: "Close",
          cancelLabel: "Cancel",
          kind: "warning",
          checkboxLabel: "Remember this choice",
        },
      },
    ]);
  });

  it("never remembers a cancelled desktop dialog", async () => {
    const host = createFakeConfirmDialogHost({
      desktopAskWithCheckbox: () => ({ confirmed: false, dontAskAgain: true }),
    });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual({
      confirmed: false,
      remember: false,
    });
  });

  it("falls back to the plain desktop dialog when the checkbox bridge is missing", async () => {
    const host = createFakeConfirmDialogHost({ desktopAsk: () => true });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual({
      confirmed: true,
      remember: false,
    });
    expect(host.desktopAsks).toHaveLength(1);
  });

  it("falls back to browser confirm with no way to remember", async () => {
    const host = createFakeConfirmDialogHost({ browserConfirm: () => true });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual({
      confirmed: true,
      remember: false,
    });
  });

  it("offers cancel, close, and close-and-remember on native", async () => {
    const host = createFakeConfirmDialogHost({ isNative: true, pressAlertButton: "Cancel" });

    await confirmDialogWithRemember(CLOSE_TERMINAL, host);

    expect(host.lastAlertButtons()).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Close", style: "destructive" },
      { text: "Close and don't ask again", style: "destructive" },
    ]);
  });

  it.each([
    ["Cancel", { confirmed: false, remember: false }],
    ["Close", { confirmed: true, remember: false }],
    ["Close and don't ask again", { confirmed: true, remember: true }],
  ])("maps the native %s button", async (pressAlertButton, expected) => {
    const host = createFakeConfirmDialogHost({ isNative: true, pressAlertButton });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual(expected);
  });

  it("declines when the native alert is dismissed", async () => {
    const host = createFakeConfirmDialogHost({ isNative: true });

    await expect(confirmDialogWithRemember(CLOSE_TERMINAL, host)).resolves.toEqual({
      confirmed: false,
      remember: false,
    });
  });
});
