import type { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import type { PasswordVault, SavedCredential, SavedLogin } from "./vault.js";

export const CREDENTIALS_SUBMITTED_CHANNEL = "paseo:browser:credentials-submitted";
export const CREDENTIALS_LOOKUP_CHANNEL = "paseo:browser:credentials-lookup";
export const PASSWORDS_RESPOND_CHANNEL = "paseo:browser:passwords:respond";
export const PASSWORDS_LIST_CHANNEL = "paseo:browser:passwords:list";
export const PASSWORDS_REMOVE_CHANNEL = "paseo:browser:passwords:remove";
export const SAVE_PASSWORD_REQUEST_EVENT = "paseo:event:browser-save-password-request";

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_FIELD_LENGTH = 1024;

export interface PasswordFrame {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
}

export interface PasswordHostContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface PasswordGuestSender {
  readonly id: number;
  readonly mainFrame: PasswordFrame;
  readonly hostWebContents: PasswordHostContents | null;
}

export interface PasswordSender {
  readonly id: number;
}

export interface SavePasswordRequest {
  browserId: string;
  requestId: string;
  origin: string;
  username: string;
  update: boolean;
}

export type SavePasswordAction = "save" | "never" | "dismiss";

export interface SavedPasswordList {
  available: boolean;
  logins: SavedLogin[];
}

interface PendingSave {
  hostWebContentsId: number;
  browserId: string;
  origin: string;
  username: string;
  password: string;
  expiresAt: number;
}

interface VerifiedGuest {
  browserId: string;
  host: PasswordHostContents;
  origin: string;
}

export interface BrowserPasswordsDeps {
  vault: PasswordVault;
  registry: PaseoBrowserWebviewRegistry;
  isHostSender(sender: PasswordSender): boolean;
  randomId(): string;
  now(): number;
  warn(event: string, details: unknown): void;
}

export interface BrowserPasswordsIpc {
  on(channel: string, listener: (event: GuestIpcEvent, payload: unknown) => void): void;
  handle(channel: string, listener: (event: GuestIpcEvent, payload: unknown) => unknown): void;
}

interface GuestIpcEvent {
  sender: PasswordGuestSender;
  senderFrame: PasswordFrame | null;
}

export class BrowserPasswords {
  private readonly pending = new Map<string, PendingSave>();

  public constructor(private readonly deps: BrowserPasswordsDeps) {}

  public credentialsSubmitted(
    sender: PasswordGuestSender,
    senderFrame: PasswordFrame | null,
    rawPayload: unknown,
  ): void {
    const guest = this.verifyGuest(sender, senderFrame);
    const credentials = parseCredentials(rawPayload);
    if (!guest || !credentials) {
      return;
    }
    const { vault } = this.deps;
    const { origin } = guest;
    if (
      !vault.isAvailable() ||
      vault.isNever(origin) ||
      vault.has(origin, credentials.username, credentials.password)
    ) {
      return;
    }
    this.prunePending();
    for (const [requestId, entry] of this.pending) {
      const isSameLogin =
        entry.hostWebContentsId === guest.host.id &&
        entry.browserId === guest.browserId &&
        entry.origin === origin &&
        entry.username === credentials.username;
      if (isSameLogin) {
        this.pending.delete(requestId);
      }
    }
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const requestId = this.deps.randomId();
    this.pending.set(requestId, {
      hostWebContentsId: guest.host.id,
      browserId: guest.browserId,
      origin,
      username: credentials.username,
      password: credentials.password,
      expiresAt: this.deps.now() + PENDING_TTL_MS,
    });
    const update = vault
      .list()
      .some((login) => login.origin === origin && login.username === credentials.username);
    const request: SavePasswordRequest = {
      browserId: guest.browserId,
      requestId,
      origin,
      username: credentials.username,
      update,
    };
    guest.host.send(SAVE_PASSWORD_REQUEST_EVENT, request);
  }

  public warn(event: string, details: unknown): void {
    this.deps.warn(event, details);
  }

  public lookup(sender: PasswordGuestSender, senderFrame: PasswordFrame | null): SavedCredential[] {
    const guest = this.verifyGuest(sender, senderFrame);
    return guest ? this.deps.vault.lookup(guest.origin) : [];
  }

  public respond(sender: PasswordSender, rawPayload: unknown): boolean {
    const payload = parseRespondPayload(rawPayload);
    if (!payload) {
      return false;
    }
    this.prunePending();
    const entry = this.pending.get(payload.requestId);
    if (!entry || entry.hostWebContentsId !== sender.id) {
      return false;
    }
    this.pending.delete(payload.requestId);
    switch (payload.action) {
      case "save":
        return this.deps.vault.save(entry.origin, entry.username, entry.password);
      case "never":
        this.deps.vault.setNever(entry.origin);
        return true;
      case "dismiss":
        return true;
    }
  }

  public list(sender: PasswordSender): SavedPasswordList {
    this.assertHost(sender);
    return { available: this.deps.vault.isAvailable(), logins: this.deps.vault.list() };
  }

  public remove(sender: PasswordSender, rawPayload: unknown): void {
    this.assertHost(sender);
    const login = parseLogin(rawPayload);
    if (!login) {
      throw new Error("Invalid saved password reference");
    }
    this.deps.vault.remove(login.origin, login.username);
  }

  private assertHost(sender: PasswordSender): void {
    if (!this.deps.isHostSender(sender)) {
      throw new Error("Saved passwords are only available to PandaOS windows");
    }
  }

  private verifyGuest(
    sender: PasswordGuestSender,
    senderFrame: PasswordFrame | null,
  ): VerifiedGuest | null {
    const registration = this.deps.registry.getRegistrationForWebContents(sender.id);
    const host = sender.hostWebContents;
    if (!registration || !host || host.isDestroyed()) {
      return null;
    }
    const isRegisteredHost = host.id === registration.hostWebContentsId;
    const isMainFrame =
      senderFrame !== null &&
      senderFrame.processId === sender.mainFrame.processId &&
      senderFrame.routingId === sender.mainFrame.routingId;
    if (!isRegisteredHost || !isMainFrame) {
      return null;
    }
    const origin = readWebOrigin(senderFrame.url);
    return origin ? { browserId: registration.browserId, host, origin } : null;
  }

  private prunePending(): void {
    const now = this.deps.now();
    for (const [requestId, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(requestId);
      }
    }
  }
}

export function registerBrowserPasswordsIpc(
  ipc: BrowserPasswordsIpc,
  passwords: BrowserPasswords,
): void {
  ipc.on(CREDENTIALS_SUBMITTED_CHANNEL, (event, payload) => {
    // Nothing awaits an ipcMain.on listener: a corrupt vault file or a locked keyring (decrypt
    // throws) would surface as a main-process error dialog on every login.
    try {
      passwords.credentialsSubmitted(event.sender, event.senderFrame, payload);
    } catch (error) {
      passwords.warn("credentials-submitted.failed", { error });
    }
  });
  ipc.handle(CREDENTIALS_LOOKUP_CHANNEL, (event) =>
    passwords.lookup(event.sender, event.senderFrame),
  );
  ipc.handle(PASSWORDS_RESPOND_CHANNEL, (event, payload) =>
    passwords.respond(event.sender, payload),
  );
  ipc.handle(PASSWORDS_LIST_CHANNEL, (event) => passwords.list(event.sender));
  ipc.handle(PASSWORDS_REMOVE_CHANNEL, (event, payload) => {
    passwords.remove(event.sender, payload);
  });
}

function readWebOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_FIELD_LENGTH;
}

function parseCredentials(value: unknown): SavedCredential | null {
  if (!isRecord(value) || !isBoundedString(value.username) || !isBoundedString(value.password)) {
    return null;
  }
  if (value.password.length === 0) {
    return null;
  }
  return { username: value.username, password: value.password };
}

function parseRespondPayload(
  value: unknown,
): { requestId: string; action: SavePasswordAction } | null {
  if (!isRecord(value) || typeof value.requestId !== "string") {
    return null;
  }
  const { action } = value;
  if (action !== "save" && action !== "never" && action !== "dismiss") {
    return null;
  }
  return { requestId: value.requestId, action };
}

function parseLogin(value: unknown): SavedLogin | null {
  if (!isRecord(value) || typeof value.origin !== "string" || !isBoundedString(value.username)) {
    return null;
  }
  return { origin: value.origin, username: value.username };
}
