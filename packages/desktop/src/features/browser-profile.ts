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

const LEGACY_PREFIX = "paseo-browser-";
// COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
// Old per-tab partitions. Open only those already on disk: fromPartition creates the directory.
function isLegacyDirectory(name: string): boolean {
  return (
    name.startsWith(LEGACY_PREFIX) &&
    LEGACY_BROWSER_ID_PATTERN.test(name.slice(LEGACY_PREFIX.length))
  );
}
export function getPaseoBrowserProfileSessions<S extends BrowserProfileSession>(
  sessions: { fromPartition(partition: string): S },
  directories: string[],
  liveSessions: Iterable<S> = [],
): S[] {
  const result = new Set([sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION)]);
  for (const name of directories) {
    if (isScopedDirectory(name) || isLegacyDirectory(name))
      result.add(sessions.fromPartition(`persist:${name}`));
  }
  // A new profile's directory may not exist yet while its guest is live.
  for (const live of liveSessions) result.add(live);
  return [...result];
}

export function getLegacyPaseoBrowserProfileSession(
  sessions: ElectronSessions,
  browserId: string,
  directories: string[],
): BrowserProfileSession | null {
  const name = LEGACY_PREFIX + browserId;
  return isLegacyDirectory(name) && directories.includes(name)
    ? sessions.fromPartition(`persist:${name}`)
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
