import { readdir } from "node:fs/promises";
import path from "node:path";

export const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";
const NAMED_SLUG = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isNamedBrowserSlug(slug: string, shared: boolean): boolean {
  return NAMED_SLUG.test(slug) && (shared ? slug !== "default" : !slug.startsWith("ws-"));
}

function isScopedDirectory(name: string): boolean {
  if (name.startsWith("paseo-shared-")) return isNamedBrowserSlug(name.slice(13), true);
  const project = /^paseo-project-[0-9a-f]{32}-(.+)$/.exec(name);
  return (
    project !== null &&
    (isNamedBrowserSlug(project[1], false) || /^ws-[0-9a-f]{32}$/.test(project[1]))
  );
}

export function isPaseoBrowserPartition(partition: unknown): partition is string {
  return (
    partition === PASEO_BROWSER_PROFILE_PARTITION ||
    (typeof partition === "string" &&
      partition.startsWith("persist:") &&
      isScopedDirectory(partition.slice("persist:".length)))
  );
}

export async function listBrowserPartitionDirectories(userData: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(userData, "Partitions"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const MAX_LEGACY_BROWSER_PROFILES = 1000;

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
  profileSessions: ReadonlySet<object>;
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

function getPaseoBrowserProfileSession(sessions: ElectronSessions): BrowserProfileSession {
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

export function getPaseoBrowserProfileSessions(
  sessions: ElectronSessions,
  legacyBrowserIds: string[],
  directories: string[],
): [BrowserProfileSession, ...BrowserProfileSession[]] {
  // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
  // Include per-tab profiles whose saved browser record no longer exists.
  const legacyPrefix = "paseo-browser-";
  const legacyIds = new Set(legacyBrowserIds);
  for (const name of directories) {
    const id = name.slice(legacyPrefix.length);
    if (name.startsWith(legacyPrefix) && LEGACY_BROWSER_ID_PATTERN.test(id)) legacyIds.add(id);
  }
  return [
    getPaseoBrowserProfileSession(sessions),
    ...directories
      .filter((name) => isScopedDirectory(name))
      .map((name) => sessions.fromPartition(`persist:${name}`)),
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    ...Array.from(legacyIds, (browserId) =>
      sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${browserId}`),
    ),
  ];
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
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      input.profileSessions.has(contents.session),
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
