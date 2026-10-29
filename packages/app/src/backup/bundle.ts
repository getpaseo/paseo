import { z } from "zod";
import { HostConfigDocumentSchema, type HostConfigDocument } from "@getpaseo/protocol/messages";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import { changesPreferencesSchema } from "@/hooks/use-changes-preferences/storage";
import type { ChangesPreferences } from "@/hooks/use-changes-preferences";
import { ShortcutOverridesSchema } from "@/hooks/use-keyboard-shortcut-overrides";
import { normalizeAppSettings, type AppSettings } from "@/hooks/use-settings/storage";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import {
  normalizeStoredHostProfile,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";

export const BACKUP_FORMAT = "paseo-backup";
export const BACKUP_VERSION = 1;

/** A saved host as it travels: never a password, only connections another device can use. */
export interface ExportedHost extends Omit<HostProfile, "password"> {
  passwordRequired: boolean;
}

export interface DeviceBackup {
  appSettings?: AppSettings;
  shortcutOverrides?: ShortcutOverrides;
  changesPreferences?: Partial<ChangesPreferences>;
  desktopSettings?: DesktopSettings;
  hosts?: ExportedHost[];
}

export interface HostBackup {
  serverId: string;
  label: string;
  document: HostConfigDocument;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  appVersion: string | null;
  device: DeviceBackup;
  hosts: HostBackup[];
}

const LOOPBACK_ENDPOINT = /^(localhost|127\.|\[::1\])/;

/**
 * Socket and pipe paths, loopback TCP, and routes through another host only work on the device
 * that saved them.
 */
export function isPortableConnection(connection: HostConnection): boolean {
  switch (connection.type) {
    case "relay":
    case "remoteSsh":
      return true;
    case "directTcp":
      return !LOOPBACK_ENDPOINT.test(connection.endpoint);
    case "directSocket":
    case "directPipe":
    case "routed":
      return false;
  }
}

export function exportHostProfile(profile: HostProfile): ExportedHost | null {
  const { password, ...rest } = profile;
  const connections = profile.connections.filter(isPortableConnection);
  if (connections.length === 0) return null;
  const preferredConnectionId = connections.some(
    (connection) => connection.id === profile.preferredConnectionId,
  )
    ? profile.preferredConnectionId
    : connections[0].id;
  return {
    ...rest,
    connections,
    preferredConnectionId,
    passwordRequired: password !== undefined,
  };
}

export function serializeBackup(backup: Backup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

const BackupEnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int(),
  createdAt: z.string(),
  appVersion: z.string().nullable().optional(),
  device: z.record(z.string(), z.unknown()),
  hosts: z.array(z.object({ serverId: z.string(), label: z.string(), document: z.unknown() })),
});

const DesktopSettingsSchema = z.strictObject({
  releaseChannel: z.enum(["stable", "beta"]),
  notifications: z.strictObject({ playSound: z.boolean() }),
  daemon: z.strictObject({ manageBuiltInDaemon: z.boolean(), keepRunningAfterQuit: z.boolean() }),
});

// The stored host schema is strict, so the export-only flag comes off before normalizing.
const ExportedHostFlagsSchema = z.looseObject({ passwordRequired: z.unknown().optional() });

export interface ImportableHost {
  profile: HostProfile;
  passwordRequired: boolean;
}

export interface ParsedBackup {
  createdAt: string;
  device: Omit<DeviceBackup, "hosts"> & { hosts?: ImportableHost[] };
  hosts: HostBackup[];
  /** Parts of the file this app cannot read; they are shown and never applied. */
  unreadable: string[];
}

export class BackupFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFileError";
  }
}

export function parseBackup(text: string): ParsedBackup {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupFileError("This file is not a Paseo backup: it is not JSON.");
  }
  const envelope = BackupEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new BackupFileError(`This file is not a Paseo backup (format "${BACKUP_FORMAT}").`);
  }
  if (envelope.data.version > BACKUP_VERSION) {
    throw new BackupFileError(
      `This backup was made by a newer version of Paseo (format version ${envelope.data.version}). Update Paseo to import it.`,
    );
  }

  const unreadable: string[] = [];
  const raw = envelope.data.device;
  const device: ParsedBackup["device"] = {};
  if (raw.appSettings !== undefined) device.appSettings = normalizeAppSettings(raw.appSettings);
  if (raw.shortcutOverrides !== undefined) {
    const parsed = ShortcutOverridesSchema.safeParse(raw.shortcutOverrides);
    if (parsed.success) device.shortcutOverrides = parsed.data;
    else unreadable.push("shortcutOverrides");
  }
  if (raw.changesPreferences !== undefined) {
    const parsed = changesPreferencesSchema.safeParse(raw.changesPreferences);
    if (parsed.success) device.changesPreferences = parsed.data;
    else unreadable.push("changesPreferences");
  }
  if (raw.desktopSettings !== undefined) {
    const parsed = DesktopSettingsSchema.safeParse(raw.desktopSettings);
    if (parsed.success) device.desktopSettings = parsed.data;
    else unreadable.push("desktopSettings");
  }
  if (Array.isArray(raw.hosts)) {
    device.hosts = raw.hosts.flatMap((entry, index) => {
      const flagged = ExportedHostFlagsSchema.safeParse(entry);
      const { passwordRequired, ...stored } = flagged.success ? flagged.data : {};
      const profile = flagged.success ? normalizeStoredHostProfile(stored) : null;
      if (!profile) {
        unreadable.push(`hosts.${index}`);
        return [];
      }
      const { password: _ignored, ...withoutPassword } = profile;
      return [{ profile: withoutPassword, passwordRequired: passwordRequired === true }];
    });
  }

  const hosts = envelope.data.hosts.flatMap((host) => {
    const document = HostConfigDocumentSchema.safeParse(host.document);
    if (!document.success) {
      unreadable.push(`host:${host.serverId}`);
      return [];
    }
    return [{ serverId: host.serverId, label: host.label, document: document.data }];
  });

  return { createdAt: envelope.data.createdAt, device, hosts, unreadable };
}
