import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import log from "electron-log/main";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StoredAuthUser = {
  userId: string;
  username: string;
  avatarUrl: string;
  email: string;
};

export type StoredAuthSession = {
  sessionToken: string;
  user: StoredAuthUser;
  providerId: string;
  expiresAt: string; // ISO 8601
};

type PersistedSessionFile =
  | {
      encryptedToken: string; // base64-encoded encrypted buffer
      user: StoredAuthUser;
      providerId: string;
      expiresAt: string;
      encrypted: true;
    }
  | {
      sessionToken: string;
      user: StoredAuthUser;
      providerId: string;
      expiresAt: string;
      encrypted: false;
    };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getSessionDir(): string {
  return path.join(app.getPath("userData"), "auth");
}

function getSessionFilePath(): string {
  return path.join(getSessionDir(), "session.json");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function saveAuthSession(session: StoredAuthSession): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let persisted: PersistedSessionFile;

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(session.sessionToken);
    persisted = {
      encryptedToken: encrypted.toString("base64"),
      user: session.user,
      providerId: session.providerId,
      expiresAt: session.expiresAt,
      encrypted: true,
    };
  } else {
    log.warn("[auth-store] safeStorage encryption unavailable — storing token in plaintext");
    persisted = {
      sessionToken: session.sessionToken,
      user: session.user,
      providerId: session.providerId,
      expiresAt: session.expiresAt,
      encrypted: false,
    };
  }

  writeFileSync(getSessionFilePath(), JSON.stringify(persisted, null, 2), "utf-8");
}

export function loadAuthSession(): StoredAuthSession | null {
  const filePath = getSessionFilePath();
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSessionFile;

    // Check expiry
    if (raw.expiresAt && new Date(raw.expiresAt) <= new Date()) {
      log.info("[auth-store] session expired, clearing");
      clearAuthSession();
      return null;
    }

    let sessionToken: string;
    if (raw.encrypted) {
      const buffer = Buffer.from(raw.encryptedToken, "base64");
      sessionToken = safeStorage.decryptString(buffer);
    } else {
      sessionToken = raw.sessionToken;
    }

    return {
      sessionToken,
      user: raw.user,
      providerId: raw.providerId,
      expiresAt: raw.expiresAt,
    };
  } catch (error) {
    log.error("[auth-store] failed to load session:", error);
    clearAuthSession();
    return null;
  }
}

export function clearAuthSession(): void {
  const filePath = getSessionFilePath();
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    log.error("[auth-store] failed to clear session:", error);
  }
}
