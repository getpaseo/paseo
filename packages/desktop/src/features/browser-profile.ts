import { readdirSync } from "node:fs";
import path from "node:path";
import {
  getHostBrowserProxyPartition,
  isHostBrowserProxyPartition,
} from "./browser-proxy/partition.js";

export const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";
const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const MAX_LEGACY_BROWSER_PROFILES = 1000;
const MAX_HOST_BROWSER_PROFILES = 500;
const DISK_HOST_PARTITION_DIR_PATTERN = /^paseo-browser-host-[0-9a-f]{16}$/;

const PASEO_BROWSER_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "shadercache",
] as const;

interface BrowserProfileSession {
  clearStorageData(options: {
    storages: Array<(typeof PASEO_BROWSER_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface BrowserProfileGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
}

interface BrowserProfileWebContents extends BrowserProfileGuest {
  readonly session: object;
  getType(): string;
}

interface ListBrowserProfileGuestsInput {
  profileSession?: object;
  profileSessions?: Iterable<object>;
  webContents: BrowserProfileWebContents[];
}

interface ClearBrowserProfileInput {
  profileSessions: BrowserProfileSession[];
  listGuests(): BrowserProfileGuest[];
  logReloadError(guestId: number, error: unknown): void;
}

interface ElectronSessions {
  fromPartition(partition: string): BrowserProfileSession;
}

export function getPaseoBrowserProfileSession(sessions: ElectronSessions): BrowserProfileSession {
  return sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
}

export function readLegacyPaseoBrowserIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const browserIds = new Set<string>();
  for (const value of input) {
    if (typeof value === "string" && LEGACY_BROWSER_ID_PATTERN.test(value)) {
      browserIds.add(value);
      if (browserIds.size >= MAX_LEGACY_BROWSER_PROFILES) {
        break;
      }
    }
  }
  return [...browserIds];
}

export function readHostBrowserProxyPartitions(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const partitions = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    partitions.add(
      isHostBrowserProxyPartition(trimmed) ? trimmed : getHostBrowserProxyPartition(trimmed),
    );
    if (partitions.size >= MAX_HOST_BROWSER_PROFILES) {
      break;
    }
  }
  return [...partitions];
}

export function listDiskHostBrowserProxyPartitions(userDataDir: string): string[] {
  try {
    const partitionsDir = path.join(userDataDir, "Partitions");
    const entries = readdirSync(partitionsDir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && DISK_HOST_PARTITION_DIR_PATTERN.test(entry.name)) {
        result.push(`persist:${entry.name}`);
      }
    }
    return result.sort();
  } catch {
    return [];
  }
}

export function getPaseoBrowserProfileSessions(
  sessions: ElectronSessions,
  legacyBrowserIds: string[],
  hostPartitions: readonly string[] = [],
): [BrowserProfileSession, ...BrowserProfileSession[]] {
  const localSession = getPaseoBrowserProfileSession(sessions);
  const seenPartitions = new Set<string>([PASEO_BROWSER_PROFILE_PARTITION]);
  const extraSessions: BrowserProfileSession[] = [];

  for (const partition of hostPartitions) {
    if (isHostBrowserProxyPartition(partition) && !seenPartitions.has(partition)) {
      seenPartitions.add(partition);
      extraSessions.push(sessions.fromPartition(partition));
    }
  }

  // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
  for (const browserId of legacyBrowserIds) {
    const partition = `${PASEO_BROWSER_PROFILE_PARTITION}-${browserId}`;
    if (!seenPartitions.has(partition)) {
      seenPartitions.add(partition);
      extraSessions.push(sessions.fromPartition(partition));
    }
  }

  return [localSession, ...extraSessions];
}

export function getLegacyPaseoBrowserProfileSession(
  sessions: ElectronSessions,
  browserId: string,
): BrowserProfileSession | null {
  const [legacyBrowserId] = readLegacyPaseoBrowserIds([browserId]);
  return legacyBrowserId
    ? sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${legacyBrowserId}`)
    : null;
}

export function listPaseoBrowserProfileGuests(
  input: ListBrowserProfileGuestsInput,
): BrowserProfileGuest[] {
  const allowedSessions = new Set<object>(input.profileSessions ?? []);
  if (input.profileSession) {
    allowedSessions.add(input.profileSession);
  }
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      allowedSessions.has(contents.session),
  );
}

export async function clearPaseoBrowserProfile(input: ClearBrowserProfileInput): Promise<void> {
  await Promise.all(
    input.profileSessions.flatMap((profileSession) => [
      profileSession.clearStorageData({ storages: [...PASEO_BROWSER_STORAGE_TYPES] }),
      profileSession.clearCache(),
      profileSession.clearAuthCache(),
    ]),
  );

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}
