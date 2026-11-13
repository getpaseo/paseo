import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { resolveAntigravityDataDir } from "./data-dir.js";

type Environment = Readonly<Record<string, string | undefined>>;
export type CredentialState =
  | { status: "available"; identity: string }
  | { status: "signed-out" }
  | { status: "unavailable" };

const unavailable: CredentialState = { status: "unavailable" };
const signedOut: CredentialState = { status: "signed-out" };
const READ_TIMEOUT_MS = 3_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Keep identities in memory only. Access-token renewal must not look like an account switch. */
export function credentialIdentity(raw: string): CredentialState {
  try {
    const text = raw.trim();
    let decoded = text;
    if (text.startsWith("go-keyring-base64:"))
      decoded = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8");
    else if (text.startsWith("go-keyring-encoded:"))
      decoded = Buffer.from(text.slice("go-keyring-encoded:".length), "hex").toString("utf8");
    const value = JSON.parse(decoded);
    if (!value || typeof value !== "object") return unavailable;
    const token = value.token ?? value;
    if (!token || typeof token !== "object") return unavailable;
    if (
      ![token.access_token, token.accessToken, token.refresh_token, token.refreshToken].some(
        (part) => typeof part === "string" && part.length > 0,
      )
    )
      return signedOut;
    if (typeof value.id_token_email === "string" && value.id_token_email.trim()) {
      return {
        status: "available",
        identity: hash(
          `${value.auth_method ?? "consumer"}\0${value.id_token_email.trim().toLowerCase()}`,
        ),
      };
    }
    // Older file stores do not include an email. Refresh tokens are stable across access renewal.
    const refreshToken = token.refresh_token ?? token.refreshToken;
    if (typeof refreshToken === "string" && refreshToken) {
      return { status: "available", identity: hash(`refresh\0${refreshToken}`) };
    }
    return unavailable;
  } catch {
    return unavailable;
  }
}

export async function readCredentialFile(env: Environment): Promise<CredentialState> {
  try {
    return credentialIdentity(
      await readFile(path.join(resolveAntigravityDataDir(env), "antigravity-oauth-token"), "utf8"),
    );
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? signedOut
      : unavailable;
  }
}

// A Secret Service session belongs to its D-Bus connection. Keep lookup/read/close in one process.
// Never send a token to stdout, a log, an exception, or a command-line argument.
const LINUX_KEYRING_READER = String.raw`
import hashlib, json
try:
    import dbus
    bus = dbus.SessionBus()
    service = dbus.Interface(bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets'), 'org.freedesktop.Secret.Service')
    collection_path = service.ReadAlias('login')
    if str(collection_path) == '/':
        raise RuntimeError('login collection unavailable')
    collection = dbus.Interface(bus.get_object('org.freedesktop.secrets', collection_path), 'org.freedesktop.Secret.Collection')
    items = collection.SearchItems({'service': 'gemini', 'username': 'antigravity'})
    unlocked, locked = [], []
    for item_path in items:
        properties = dbus.Interface(bus.get_object('org.freedesktop.secrets', item_path), 'org.freedesktop.DBus.Properties')
        (locked if properties.Get('org.freedesktop.Secret.Item', 'Locked') else unlocked).append(item_path)
    if locked and not unlocked:
        print(json.dumps({'status': 'unavailable'}))
    elif not unlocked:
        print(json.dumps({'status': 'signed-out'}))
    else:
        _, session = service.OpenSession('plain', dbus.String('', variant_level=1))
        try:
            item = dbus.Interface(bus.get_object('org.freedesktop.secrets', unlocked[0]), 'org.freedesktop.Secret.Item')
            secret = item.GetSecret(session)
            value = json.loads(bytes(secret[2]).decode('utf-8'))
            email = value.get('id_token_email', '').strip().lower()
            token = value.get('token') or value
            refresh = token.get('refresh_token') or token.get('refreshToken')
            identity = (value.get('auth_method') or 'consumer') + '\0' + email if email else 'refresh\0' + refresh if refresh else None
            has_token = any(isinstance(token.get(k), str) and token[k] for k in ['access_token', 'accessToken', 'refresh_token', 'refreshToken'])
            print(json.dumps({'status': 'available', 'identity': hashlib.sha256(identity.encode()).hexdigest()} if has_token and identity else {'status': 'unavailable' if has_token else 'signed-out'}))
        finally:
            dbus.Interface(bus.get_object('org.freedesktop.secrets', session), 'org.freedesktop.Secret.Session').Close()
except Exception as error:
    # agy falls back to its file store when the Secret Service cannot be activated.
    # A session bus can exist on a headless host without any keyring service.
    name = getattr(error, 'get_dbus_name', lambda: None)()
    missing_service = name in ['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.Spawn.ServiceNotFound']
    print(json.dumps({'status': 'file-fallback' if missing_service else 'unavailable'}))
`;

const WINDOWS_KEYRING_READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PaseoAntigravityCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist, AttributeCount; public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
if (![PaseoAntigravityCredential]::CredReadW('gemini:antigravity', 1, 0, [ref]$ptr)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
  exit 1
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PaseoAntigravityCredential+Credential])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Write([Text.Encoding]::UTF8.GetString($bytes))
} finally { [PaseoAntigravityCredential]::CredFree($ptr) }
`;

async function externalCredentials(env: Environment): Promise<CredentialState | null> {
  if (env.AGY_ADC_AUTH?.trim()) {
    return { status: "available", identity: hash(`adc\0${env.GOOGLE_CLOUD_QUOTA_PROJECT ?? ""}`) };
  }
  const dataDir = resolveAntigravityDataDir(env);
  try {
    const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
    if (settings.modelProvider === "gemini") {
      return env.GEMINI_API_KEY
        ? { status: "available", identity: hash(`api\0${env.GEMINI_API_KEY}`) }
        : signedOut;
    }
  } catch {
    // Settings are optional. Their absence does not mean that the user has signed out.
  }
  return null;
}

async function linuxBusAddress(env: Environment): Promise<string | null> {
  const address = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  if (address && address !== "none:" && address !== "disabled:") return address;
  const socket = path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, "bus");
  try {
    return (await stat(socket)).isSocket() ? `unix:path=${socket}` : null;
  } catch {
    return null;
  }
}

async function keyringBypassed(env: Environment): Promise<boolean> {
  if (
    env.SSH_CONNECTION ||
    env.SSH_CLIENT ||
    env.SSH_TTY ||
    env.WSL_DISTRO_NAME ||
    env.WSL_INTEROP ||
    (process.platform === "linux" && !(await linuxBusAddress(env)))
  )
    return true;
  if (process.platform === "linux") {
    for (const file of ["/.dockerenv", "/run/.containerenv"]) {
      try {
        if ((await stat(file)).isFile()) return true;
      } catch {
        /* Not a container. */
      }
    }
  }
  try {
    const marker = await stat(
      path.join(resolveAntigravityDataDir(env), "cache", "antigravity-keyring-unavailable"),
    );
    return Date.now() - marker.mtimeMs < 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export async function readCredentialState(env: Environment): Promise<CredentialState> {
  const external = await externalCredentials(env);
  if (external) return external;
  if (await keyringBypassed(env)) return readCredentialFile(env);

  try {
    if (process.platform === "linux") {
      const { stdout } = await execCommand("python3", ["-c", LINUX_KEYRING_READER], {
        env: { ...env, DBUS_SESSION_BUS_ADDRESS: (await linuxBusAddress(env)) ?? undefined },
        shell: false,
        timeout: READ_TIMEOUT_MS,
      });
      const result = JSON.parse(stdout);
      if (result.status === "available" && /^[a-f0-9]{64}$/.test(result.identity)) return result;
      if (result.status === "signed-out" || result.status === "file-fallback")
        return readCredentialFile(env);
      return unavailable;
    }
    const { stdout } =
      process.platform === "darwin"
        ? await execCommand(
            "/usr/bin/security",
            ["find-generic-password", "-s", "gemini", "-wa", "antigravity"],
            { env: { ...env }, shell: false, timeout: READ_TIMEOUT_MS },
          )
        : await execCommand(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEYRING_READER],
            { env: { ...env }, shell: false, timeout: READ_TIMEOUT_MS },
          );
    return credentialIdentity(stdout);
  } catch (error) {
    // Locked stores and read timeouts are not logout. Never propagate command errors containing secrets.
    return error instanceof Error && "code" in error && error.code === 44
      ? readCredentialFile(env)
      : unavailable;
  }
}

export interface CredentialWatch {
  read(): Promise<CredentialState>;
  dispose(): void;
}

/** Share one poll per credential store, including across provider connections and sessions. */
export class CredentialMonitor {
  private readonly stores = new Map<
    string,
    {
      env: Environment;
      state: CredentialState | null;
      pending: Promise<CredentialState> | null;
      timer: NodeJS.Timeout;
      listeners: Set<(state: CredentialState) => void>;
    }
  >();

  constructor(
    private readonly options: {
      read?: (env: Environment) => Promise<CredentialState>;
      intervalMs?: number;
    } = {},
  ) {}

  async read(env: Environment): Promise<CredentialState> {
    try {
      return await (this.options.read ?? readCredentialState)(env);
    } catch {
      return unavailable;
    }
  }

  watch(env: Environment, changed: (state: CredentialState) => void): CredentialWatch {
    const key = hash(
      JSON.stringify([
        resolveAntigravityDataDir(env),
        env.DBUS_SESSION_BUS_ADDRESS,
        env.SSH_CONNECTION,
        env.SSH_CLIENT,
        env.SSH_TTY,
        env.AGY_ADC_AUTH,
        env.GEMINI_API_KEY,
        env.GOOGLE_CLOUD_QUOTA_PROJECT,
        env.WSL_DISTRO_NAME,
        env.WSL_INTEROP,
      ]),
    );
    let store = this.stores.get(key);
    if (!store) {
      const timer = setInterval(() => {
        void this.refresh(key);
      }, this.options.intervalMs ?? 1_000);
      timer.unref();
      store = { env, state: null, pending: null, timer, listeners: new Set() };
      this.stores.set(key, store);
    }
    store.listeners.add(changed);
    return {
      read: () => this.refresh(key),
      dispose: () => {
        store.listeners.delete(changed);
        if (store.listeners.size === 0) {
          clearInterval(store.timer);
          if (this.stores.get(key) === store) this.stores.delete(key);
        }
      },
    };
  }

  private async refresh(key: string): Promise<CredentialState> {
    const store = this.stores.get(key);
    if (!store) return unavailable;
    if (store.pending) return store.pending;
    const pending = this.poll(key, store);
    store.pending = pending;
    try {
      return await pending;
    } finally {
      if (store.pending === pending) store.pending = null;
    }
  }

  private async poll(
    key: string,
    store: NonNullable<ReturnType<typeof this.stores.get>>,
  ): Promise<CredentialState> {
    let next: CredentialState;
    try {
      next = await this.read(store.env);
    } catch {
      next = unavailable;
    }
    if (this.stores.get(key) !== store) return next;
    if (next.status === "unavailable") {
      store.state ??= next;
      return next;
    }
    const previous = store.state;
    store.state = next;
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
      for (const listener of store.listeners) listener(next);
    }
    return next;
  }
}
