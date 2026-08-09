import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubCommandError } from "./error.js";
import { normalizeHubOrigin } from "./origin.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const credentialRecordSchema = z
  .object({ origin: z.string(), credential: z.string().min(1) })
  .strict();
const credentialFileSchema = z
  .object({
    version: z.literal(1),
    activeOrigin: z.string().nullable(),
    credentials: z.array(credentialRecordSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const origins = new Set<string>();
    for (const record of value.credentials) {
      let normalized: string;
      try {
        normalized = normalizeHubOrigin(record.origin);
      } catch {
        context.addIssue({ code: "custom", message: "Credential origin is invalid" });
        continue;
      }
      if (normalized !== record.origin || origins.has(record.origin)) {
        context.addIssue({
          code: "custom",
          message: "Credential origins must be unique and normalized",
        });
      }
      origins.add(record.origin);
    }
    if (value.activeOrigin !== null && !origins.has(value.activeOrigin)) {
      context.addIssue({ code: "custom", message: "Active credential is missing" });
    }
  });

type CredentialFile = z.infer<typeof credentialFileSchema>;

export interface StoredHubCredential {
  origin: string;
  credential: string;
}

export interface HubCredentialStore {
  active(): StoredHubCredential | null;
  get(origin: string): StoredHubCredential | null;
  save(credential: StoredHubCredential): void;
  logoutActive(): StoredHubCredential | null;
}

export class PrivateHubCredentialStore implements HubCredentialStore {
  private readonly filePath: string;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.filePath = path.join(resolvePaseoHome(env), "hub-credentials.json");
  }

  active(): StoredHubCredential | null {
    const data = this.read();
    if (data.activeOrigin === null) return null;
    return data.credentials.find((record) => record.origin === data.activeOrigin) ?? null;
  }

  get(origin: string): StoredHubCredential | null {
    const normalizedOrigin = normalizeHubOrigin(origin);
    return this.read().credentials.find((record) => record.origin === normalizedOrigin) ?? null;
  }

  save(credential: StoredHubCredential): void {
    const origin = normalizeHubOrigin(credential.origin);
    const current = this.read();
    const remaining = current.credentials.filter((record) => record.origin !== origin);
    this.write({
      version: 1,
      activeOrigin: origin,
      credentials: [...remaining, { origin, credential: credential.credential }],
    });
  }

  logoutActive(): StoredHubCredential | null {
    const current = this.read();
    if (current.activeOrigin === null) return null;
    const removed = current.credentials.find((record) => record.origin === current.activeOrigin);
    if (removed === undefined) throw invalidCredentialFile();
    this.write({
      version: 1,
      activeOrigin: null,
      credentials: current.credentials.filter((record) => record.origin !== current.activeOrigin),
    });
    return removed;
  }

  private read(): CredentialFile {
    let contents: string;
    try {
      contents = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, activeOrigin: null, credentials: [] };
      throw credentialStorageError();
    }
    chmodPrivate(this.filePath, PRIVATE_FILE_MODE);
    try {
      return credentialFileSchema.parse(JSON.parse(contents));
    } catch {
      throw invalidCredentialFile();
    }
  }

  private write(value: CredentialFile): void {
    const parsed = credentialFileSchema.parse(value);
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodPrivate(directory, PRIVATE_DIRECTORY_MODE);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      renameSync(temporaryPath, this.filePath);
      chmodPrivate(this.filePath, PRIVATE_FILE_MODE);
    } catch {
      rmSync(temporaryPath, { force: true });
      throw credentialStorageError();
    }
  }
}

function resolvePaseoHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.PASEO_HOME ?? "~/.paseo";
  const expanded = configured === "~" ? homedir() : configured.replace(/^~\//u, `${homedir()}/`);
  return path.resolve(expanded);
}

function chmodPrivate(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    throw credentialStorageError();
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invalidCredentialFile(): HubCommandError {
  return new HubCommandError(
    "HUB_CREDENTIALS_INVALID",
    "Stored Hub login is invalid. Run `paseo hub login <origin>` to replace it.",
  );
}

function credentialStorageError(): HubCommandError {
  return new HubCommandError(
    "HUB_CREDENTIALS_UNAVAILABLE",
    "Could not access the private Hub credential store under PASEO_HOME.",
  );
}
