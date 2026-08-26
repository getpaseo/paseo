import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopSettingsStore,
  type DesktopSettingsStore,
} from "../settings/desktop-settings.js";
import { buildCustomSchemePrompt, decideExternalUrl, registerOpenerHandlers } from "./opener";

vi.mock("electron", () => ({
  app: { getApplicationNameForProtocol: vi.fn(() => "") },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

describe("external URL decisions", () => {
  it("opens http and https without asking", () => {
    expect(decideExternalUrl({ url: "https://example.com/path", approvedSchemes: [] })).toEqual({
      kind: "open",
      url: "https://example.com/path",
    });
    expect(decideExternalUrl({ url: "http://localhost:8081", approvedSchemes: [] })).toEqual({
      kind: "open",
      url: "http://localhost:8081",
    });
  });

  it("rejects values that are not parseable URLs", () => {
    expect(decideExternalUrl({ url: "/relative/path", approvedSchemes: [] })).toEqual({
      kind: "reject",
      reason: "malformed",
    });
    expect(decideExternalUrl({ url: null, approvedSchemes: [] })).toEqual({
      kind: "reject",
      reason: "malformed",
    });
  });

  it("rejects schemes that can execute code or reach app internals", () => {
    const dangerous = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/1234",
      "about:blank",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "vbscript:msgbox(1)",
      "paseo://app/settings",
    ];

    for (const url of dangerous) {
      expect(decideExternalUrl({ url, approvedSchemes: [] })).toEqual({
        kind: "reject",
        reason: "dangerous-scheme",
      });
    }
  });

  it("rejects a dangerous scheme even when it was somehow approved", () => {
    expect(decideExternalUrl({ url: "file:///etc/passwd", approvedSchemes: ["file"] })).toEqual({
      kind: "reject",
      reason: "dangerous-scheme",
    });
  });

  it("asks about an unapproved custom scheme", () => {
    expect(decideExternalUrl({ url: "obsidian://task/42", approvedSchemes: [] })).toEqual({
      kind: "confirm",
      url: "obsidian://task/42",
      scheme: "obsidian",
    });
  });

  it("opens an approved custom scheme without asking", () => {
    expect(decideExternalUrl({ url: "OBSIDIAN://task/42", approvedSchemes: ["obsidian"] })).toEqual(
      { kind: "open", url: "OBSIDIAN://task/42" },
    );
  });
});

describe("custom scheme prompt copy", () => {
  it("names the registered application when the system knows it", () => {
    expect(
      buildCustomSchemePrompt({
        url: "obsidian://task/42",
        scheme: "obsidian",
        applicationName: "Obsidian",
      }),
    ).toEqual({
      message: "Open this link in Obsidian?",
      detail: "obsidian://task/42",
      checkboxLabel: "Always open obsidian: links",
    });
  });

  it("falls back to the scheme when no application is registered", () => {
    expect(
      buildCustomSchemePrompt({
        url: "obsidian://task/42",
        scheme: "obsidian",
        applicationName: "",
      }),
    ).toEqual({
      message: 'Open this link in the app registered for "obsidian" links?',
      detail: "obsidian://task/42",
      checkboxLabel: "Always open obsidian: links",
    });
  });
});

describe("desktop opener", () => {
  const directories = new Set<string>();

  async function createSettingsStore(): Promise<DesktopSettingsStore> {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-opener-"));
    directories.add(userDataPath);
    return createDesktopSettingsStore({ userDataPath });
  }

  async function registerHandler(
    settingsStore: DesktopSettingsStore,
  ): Promise<(event: unknown, url: unknown) => Promise<void>> {
    registerOpenerHandlers({ settingsStore });
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
      return channel === "paseo:opener:openUrl";
    })?.[1];
    if (typeof handler !== "function") {
      throw new Error("open URL handler was not registered");
    }
    return handler as (event: unknown, url: unknown) => Promise<void>;
  }

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
    vi.mocked(shell.openExternal).mockReset();
    vi.mocked(dialog.showMessageBox).mockReset();
    vi.mocked(app.getApplicationNameForProtocol).mockReset().mockReturnValue("");
    vi.mocked(BrowserWindow.fromWebContents).mockReset().mockReturnValue(null);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReset().mockReturnValue(null);
  });

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("opens allowed URLs through Electron shell", async () => {
    const handler = await registerHandler(await createSettingsStore());

    await handler({ sender: {} }, "https://example.com");

    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("rejects blocked URLs before invoking Electron shell", async () => {
    const handler = await registerHandler(await createSettingsStore());

    await expect(handler({ sender: {} }, "file:///etc/passwd")).rejects.toThrow(
      "Unsupported external URL",
    );

    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("opens an unapproved custom scheme once the user confirms", async () => {
    const settingsStore = await createSettingsStore();
    const handler = await registerHandler(settingsStore);
    vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("Obsidian");
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await handler({ sender: {} }, "obsidian://task/42");
    const settings = await settingsStore.get();

    expect(dialog.showMessageBox).toHaveBeenCalledWith({
      type: "question",
      title: "Open external link",
      message: "Open this link in Obsidian?",
      detail: "obsidian://task/42",
      buttons: ["Cancel", "Open"],
      defaultId: 1,
      cancelId: 0,
      checkboxLabel: "Always open obsidian: links",
      checkboxChecked: false,
    });
    expect(shell.openExternal).toHaveBeenCalledWith("obsidian://task/42");
    expect(settings.links.approvedSchemes).toEqual([]);
  });

  it("does not open or approve anything when the user cancels", async () => {
    const settingsStore = await createSettingsStore();
    const handler = await registerHandler(settingsStore);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: true });

    await expect(handler({ sender: {} }, "obsidian://task/42")).resolves.toBeUndefined();
    const settings = await settingsStore.get();

    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(settings.links.approvedSchemes).toEqual([]);
  });

  it("remembers the scheme when the user checks always open", async () => {
    const settingsStore = await createSettingsStore();
    const handler = await registerHandler(settingsStore);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: true });

    await handler({ sender: {} }, "obsidian://task/42");
    const settings = await settingsStore.get();

    expect(settings.links.approvedSchemes).toEqual(["obsidian"]);
    expect(shell.openExternal).toHaveBeenCalledWith("obsidian://task/42");
  });

  it("skips the dialog for an already approved scheme", async () => {
    const settingsStore = await createSettingsStore();
    await settingsStore.patch({ links: { approvedSchemes: ["obsidian"] } });
    const handler = await registerHandler(settingsStore);

    await handler({ sender: {} }, "obsidian://task/43");

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith("obsidian://task/43");
  });
});
