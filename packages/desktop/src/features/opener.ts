import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import type { DesktopSettingsStore } from "../settings/desktop-settings.js";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

// Schemes that run code or address surfaces inside the app. `paseo:` serves the
// renderer itself, so handing it to the shell would loop back into Paseo.
const DENIED_EXTERNAL_URL_SCHEMES = new Set([
  "about",
  "blob",
  "chrome",
  "data",
  "devtools",
  "file",
  "javascript",
  "paseo",
  "vbscript",
]);

export type ExternalUrlRejectionReason = "malformed" | "dangerous-scheme";

export type ExternalUrlDecision =
  | { kind: "open"; url: string }
  | { kind: "confirm"; url: string; scheme: string }
  | { kind: "reject"; reason: ExternalUrlRejectionReason };

interface ExternalUrlRequest {
  url: unknown;
  approvedSchemes: readonly string[];
}

interface CustomSchemePromptInput {
  url: string;
  scheme: string;
  applicationName: string;
}

interface CustomSchemePrompt {
  message: string;
  detail: string;
  checkboxLabel: string;
}

export class UnsupportedExternalUrlError extends Error {
  readonly reason: ExternalUrlRejectionReason;

  constructor(reason: ExternalUrlRejectionReason) {
    super("Unsupported external URL");
    this.name = "UnsupportedExternalUrlError";
    this.reason = reason;
  }
}

export function decideExternalUrl({
  url,
  approvedSchemes,
}: ExternalUrlRequest): ExternalUrlDecision {
  if (typeof url !== "string") {
    return { kind: "reject", reason: "malformed" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "reject", reason: "malformed" };
  }

  if (ALLOWED_EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) {
    return { kind: "open", url };
  }

  const scheme = parsed.protocol.slice(0, -1);
  if (DENIED_EXTERNAL_URL_SCHEMES.has(scheme)) {
    return { kind: "reject", reason: "dangerous-scheme" };
  }

  if (approvedSchemes.includes(scheme)) {
    return { kind: "open", url };
  }

  return { kind: "confirm", url, scheme };
}

export function buildCustomSchemePrompt({
  url,
  scheme,
  applicationName,
}: CustomSchemePromptInput): CustomSchemePrompt {
  const target = applicationName || `the app registered for "${scheme}" links`;
  return {
    message: `Open this link in ${target}?`,
    detail: url,
    checkboxLabel: `Always open ${scheme}: links`,
  };
}

async function askToOpenCustomScheme(
  sender: Electron.WebContents,
  prompt: CustomSchemePrompt,
): Promise<Electron.MessageBoxReturnValue> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Open external link",
    message: prompt.message,
    detail: prompt.detail,
    buttons: ["Cancel", "Open"],
    defaultId: 1,
    cancelId: 0,
    checkboxLabel: prompt.checkboxLabel,
    checkboxChecked: false,
  };

  const window = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow();
  if (!window) {
    return await dialog.showMessageBox(options);
  }
  return await dialog.showMessageBox(window, options);
}

async function confirmCustomScheme({
  url,
  scheme,
  sender,
  settingsStore,
}: {
  url: string;
  scheme: string;
  sender: Electron.WebContents;
  settingsStore: DesktopSettingsStore;
}): Promise<void> {
  const prompt = buildCustomSchemePrompt({
    url,
    scheme,
    applicationName: app.getApplicationNameForProtocol(url),
  });
  const answer = await askToOpenCustomScheme(sender, prompt);
  if (answer.response !== 1) {
    return;
  }

  if (answer.checkboxChecked) {
    const settings = await settingsStore.get();
    await settingsStore.patch({
      links: { approvedSchemes: [...settings.links.approvedSchemes, scheme] },
    });
  }

  await shell.openExternal(url);
}

export function registerOpenerHandlers({
  settingsStore,
}: {
  settingsStore: DesktopSettingsStore;
}): void {
  ipcMain.handle("paseo:opener:openUrl", async (event, url: unknown) => {
    const settings = await settingsStore.get();
    const decision = decideExternalUrl({ url, approvedSchemes: settings.links.approvedSchemes });

    if (decision.kind === "reject") {
      throw new UnsupportedExternalUrlError(decision.reason);
    }

    if (decision.kind === "open") {
      await shell.openExternal(decision.url);
      return;
    }

    await confirmCustomScheme({
      url: decision.url,
      scheme: decision.scheme,
      sender: event.sender,
      settingsStore,
    });
  });
}
