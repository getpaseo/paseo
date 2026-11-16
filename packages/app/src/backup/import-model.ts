import type {
  DaemonConfigImportApplyResponse,
  DaemonConfigImportPreviewResponse,
  HostConfigDocument,
} from "@getpaseo/protocol/messages";
import type { DesktopSettingsPatch } from "@/desktop/settings/desktop-settings";
import type { ChangesPreferences } from "@/hooks/use-changes-preferences";
import type { AppSettings } from "@/hooks/use-settings/storage";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import type { HostProfile } from "@/types/host-connection";
import type { HostBackup, ParsedBackup } from "./bundle";

export type HostImportPreview = Omit<DaemonConfigImportPreviewResponse["payload"], "requestId">;
type HostImportOutcome = Omit<DaemonConfigImportApplyResponse["payload"], "requestId">;

/** The device sections a backup can carry. Desktop daemon toggles describe this machine only. */
export type DeviceItemId =
  | "appSettings"
  | "shortcutOverrides"
  | "changesPreferences"
  | "desktopSettings"
  | "desktopDaemon"
  | "hosts";

export interface HostImportChoice {
  /** The host the settings came from, as named in the backup. */
  sourceServerId: string;
  /** The connected host they go to; null leaves this part of the backup out. */
  targetServerId: string | null;
  sections: string[];
  plugins: string[];
  enablePlugins: boolean;
}

export interface ImportSelection {
  device: DeviceItemId[];
  hosts: HostImportChoice[];
}

export interface BackupImportResult {
  /** "device", or the serverId of the host the item was applied to. */
  scope: string;
  item: string;
  outcome: "applied" | "skipped" | "failed";
  reason?: string;
}

export interface ReenterItem {
  scope: string;
  path: string;
  kind: "secret" | "machine-path" | "password";
}

export interface BackupImportPorts {
  saveAppSettings(settings: AppSettings): Promise<void>;
  replaceShortcutOverrides(overrides: ShortcutOverrides): Promise<void>;
  saveChangesPreferences(preferences: Partial<ChangesPreferences>): Promise<void>;
  patchDesktopSettings(patch: DesktopSettingsPatch): Promise<void>;
  importHosts(profiles: HostProfile[]): Promise<void>;
  applyHostImport(
    serverId: string,
    request: {
      document: HostConfigDocument;
      sections: string[];
      plugins: string[];
      enablePlugins: boolean;
    },
  ): Promise<HostImportOutcome>;
}

export function availableDeviceItems(backup: ParsedBackup, isDesktop: boolean): DeviceItemId[] {
  const { device } = backup;
  const items: DeviceItemId[] = [];
  if (device.appSettings) items.push("appSettings");
  if (device.shortcutOverrides) items.push("shortcutOverrides");
  if (device.changesPreferences) items.push("changesPreferences");
  if (device.desktopSettings && isDesktop) items.push("desktopSettings", "desktopDaemon");
  if (device.hosts && device.hosts.length > 0) items.push("hosts");
  return items;
}

export function defaultDeviceSelection(items: readonly DeviceItemId[]): DeviceItemId[] {
  return items.filter((item) => item !== "desktopDaemon");
}

/** Everything the target can apply is ticked, except turning plugins on, which the user asks for. */
export function defaultHostChoice(
  sourceServerId: string,
  targetServerId: string | null,
  preview: HostImportPreview | null,
): HostImportChoice {
  return {
    sourceServerId,
    targetServerId,
    sections: (preview?.sections ?? [])
      .filter((section) => section.status === "ready")
      .map((section) => section.id),
    plugins: (preview?.plugins ?? [])
      .filter((plugin) => plugin.status === "install")
      .map((plugin) => plugin.id),
    enablePlugins: false,
  };
}

/** A host's answer about one part of the backup, tagged with the host that was asked. */
export type HostPreviewState =
  | { status: "loading"; target: string }
  | { status: "ready"; target: string; preview: HostImportPreview }
  | { status: "error"; target: string; message: string };

/**
 * Decides which parts to send to their target host now, and which unfinished answers to drop.
 * A host is only asked while it is connected: the client rejects the request during a reconnect,
 * and on Android the file picker backgrounds the app, so the sheet opens mid-reconnect. An answer
 * that was pending or failed when its host dropped is asked for again once the host is back.
 */
export function planPreviewRequests(
  parts: readonly HostBackup[],
  targets: Readonly<Record<string, string | null>>,
  isOnline: (serverId: string) => boolean,
  previews: Readonly<Record<string, HostPreviewState | undefined>>,
): { ask: { part: HostBackup; target: string }[]; forget: string[] } {
  const ask: { part: HostBackup; target: string }[] = [];
  const forget: string[] = [];
  for (const part of parts) {
    const target = targets[part.serverId];
    if (!target) continue;
    const preview = previews[part.serverId];
    const answered = preview?.target === target;
    if (!isOnline(target)) {
      if (answered && preview.status !== "ready") forget.push(part.serverId);
      continue;
    }
    if (!answered) ask.push({ part, target });
  }
  return { ask, forget };
}

/** A target host's connection as the import sees it: hosts answer only while online. */
export type HostConnection = "online" | "connecting" | "offline";

/** Where one part of the backup stands against the host chosen in "Apply to". */
export type HostPartState =
  | { kind: "unassigned" }
  | { kind: "checking" }
  | { kind: "offline" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; preview: HostImportPreview; choice: HostImportChoice };

/**
 * A part is ready only when the chosen host answered for it, so Apply can never send it
 * unchecked or to a host the user switched away from. Edits made against another host are
 * dropped for that host's defaults.
 */
export function hostPartState(
  sourceServerId: string,
  target: string | null,
  connection: HostConnection,
  preview: HostPreviewState | undefined,
  editedChoice: HostImportChoice | undefined,
): HostPartState {
  if (!target) return { kind: "unassigned" };
  const answer = preview?.target === target ? preview : undefined;
  if (answer?.status === "ready") {
    const choice =
      editedChoice?.targetServerId === target
        ? editedChoice
        : defaultHostChoice(sourceServerId, target, answer.preview);
    return { kind: "ready", preview: answer.preview, choice };
  }
  if (answer?.status === "error") return { kind: "failed", message: answer.message };
  return connection === "offline" ? { kind: "offline" } : { kind: "checking" };
}

/**
 * The host parts Apply sends, or null while any chosen host has not answered yet. A part the
 * host rejected stays out, as its error is already shown.
 */
export function hostSelection(states: readonly HostPartState[]): HostImportChoice[] | null {
  if (states.some((state) => state.kind === "checking" || state.kind === "offline")) return null;
  return states.flatMap((state) => (state.kind === "ready" ? [state.choice] : []));
}

export function toggle<T>(items: readonly T[], item: T): T[] {
  return items.includes(item) ? items.filter((entry) => entry !== item) : [...items, item];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyDeviceItem(
  item: DeviceItemId,
  backup: ParsedBackup,
  ports: BackupImportPorts,
): Promise<void> {
  const { device } = backup;
  switch (item) {
    case "appSettings":
      if (device.appSettings) await ports.saveAppSettings(device.appSettings);
      return;
    case "shortcutOverrides":
      if (device.shortcutOverrides) await ports.replaceShortcutOverrides(device.shortcutOverrides);
      return;
    case "changesPreferences":
      if (device.changesPreferences) await ports.saveChangesPreferences(device.changesPreferences);
      return;
    case "desktopSettings":
      if (device.desktopSettings) {
        const { releaseChannel, notifications } = device.desktopSettings;
        await ports.patchDesktopSettings({ releaseChannel, notifications });
      }
      return;
    case "desktopDaemon":
      if (device.desktopSettings) {
        await ports.patchDesktopSettings({ daemon: device.desktopSettings.daemon });
      }
      return;
    case "hosts":
      if (device.hosts) await ports.importHosts(device.hosts.map((host) => host.profile));
      return;
  }
}

/**
 * Applies what the user ticked. Each device section and each host is attempted on its own, so
 * one failure is reported next to the others instead of stopping them.
 */
export async function applyBackup(
  backup: ParsedBackup,
  selection: ImportSelection,
  ports: BackupImportPorts,
): Promise<{ results: BackupImportResult[]; reenter: ReenterItem[] }> {
  const results: BackupImportResult[] = [];
  const reenter: ReenterItem[] = [];

  for (const item of selection.device) {
    try {
      await applyDeviceItem(item, backup, ports);
      results.push({ scope: "device", item, outcome: "applied" });
    } catch (error) {
      results.push({ scope: "device", item, outcome: "failed", reason: errorMessage(error) });
    }
  }
  if (selection.device.includes("hosts")) {
    for (const host of backup.device.hosts ?? []) {
      if (host.passwordRequired) {
        reenter.push({ scope: host.profile.serverId, path: host.profile.label, kind: "password" });
      }
    }
  }

  for (const choice of selection.hosts) {
    const part = backup.hosts.find((host) => host.serverId === choice.sourceServerId);
    if (!part || !choice.targetServerId) continue;
    const target = choice.targetServerId;
    try {
      const outcome = await ports.applyHostImport(target, {
        document: part.document,
        sections: choice.sections,
        plugins: choice.plugins,
        enablePlugins: choice.enablePlugins,
      });
      for (const result of outcome.results) {
        results.push({
          scope: target,
          item: result.item,
          outcome: result.outcome,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
      }
      for (const entry of outcome.reenter) {
        reenter.push({ scope: target, path: entry.path, kind: entry.kind });
      }
    } catch (error) {
      results.push({ scope: target, item: "host", outcome: "failed", reason: errorMessage(error) });
    }
  }

  return { results, reenter };
}
