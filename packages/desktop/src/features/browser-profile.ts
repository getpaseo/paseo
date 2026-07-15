export const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

const PASEO_BROWSER_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "websql",
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
  profileSession: object;
  webContents: BrowserProfileWebContents[];
}

interface ClearBrowserProfileInput {
  profileSession: BrowserProfileSession;
  listGuests(): BrowserProfileGuest[];
  logReloadError(guestId: number, error: unknown): void;
}

interface ElectronSessions {
  fromPartition(partition: string): Electron.Session;
}

export function getPaseoBrowserProfileSession(sessions: ElectronSessions): Electron.Session {
  return sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
}

export function listPaseoBrowserProfileGuests(
  input: ListBrowserProfileGuestsInput,
): BrowserProfileGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      contents.getType() === "webview" &&
      contents.session === input.profileSession,
  );
}

export async function clearPaseoBrowserProfile(input: ClearBrowserProfileInput): Promise<void> {
  await Promise.all([
    input.profileSession.clearStorageData({ storages: [...PASEO_BROWSER_STORAGE_TYPES] }),
    input.profileSession.clearCache(),
    input.profileSession.clearAuthCache(),
  ]);

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
