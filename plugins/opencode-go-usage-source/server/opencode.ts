import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { Input } from "../shared/input.js";

/** The OpenCode installed for the daemon's user. */
export interface OpenCodeInstall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Where OpenCode 1 keeps its logins. */
  authFile: string;
}

/** A credential OpenCode can serve Go with. Anything else on the integration is ignored. */
export type GoCredential =
  | { type: "key"; key: string }
  | { type: "console"; access: string; expires: number; orgID: string };

/** The selected credential on each integration that can carry OpenCode Go. */
export interface Logins {
  /** OpenCode binds Go to this integration when the Console workspace has Go. */
  opencode: GoCredential | null;
  go: GoCredential | null;
}

const CONSOLE_SERVER = "https://opencode.ai/console";
const ORGANIZATION_ID = /^(?:org|wrk)_[A-Za-z0-9]+$/;
const VERSION = /^(?:opencode\s+)?v?(\d+)\./i;

const fileSchema = z.object({
  "opencode-go": z.object({ type: z.literal("api"), key: z.string().min(1) }).optional(),
});
const exportSchema = z.array(
  z.object({ integrationID: z.string(), active: z.boolean(), value: z.unknown() }),
);
const metadataSchema = z
  .object({ server: z.string().optional(), orgID: z.string().optional() })
  .optional();
const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: z.string().min(1), metadata: metadataSchema }),
  z.object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    expires: z.number(),
    metadata: metadataSchema,
  }),
]);

export function installedOpenCode(env: NodeJS.ProcessEnv = process.env): OpenCodeInstall {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return { command: "opencode", args: [], env, authFile: join(dataHome, "opencode", "auth.json") };
}

/**
 * Where the installed OpenCode keeps its logins. OpenCode 2 keeps them behind its own credential
 * listing. OpenCode 1 keeps them in auth.json, even though its database has a credential table too.
 */
export async function loginStore(install: OpenCodeInstall): Promise<Input["store"]> {
  let version: string;
  try {
    const { stdout } = await execCommand(install.command, [...install.args, "--version"], {
      env: install.env,
      timeout: 5_000,
    });
    version = stdout.trim();
  } catch {
    // The daemon treats an OpenCode that does not answer as OpenCode 1 too.
    return "file";
  }
  return Number(VERSION.exec(version)?.[1] ?? 1) >= 2 ? "credentials" : "file";
}

/** Re-reads the store. A failed OpenCode 2 read throws, so it never reads as "no login". */
export async function readLogins(install: OpenCodeInstall, store: Input["store"]): Promise<Logins> {
  if (store === "file") {
    const key = await readFileKey(install.authFile);
    return { opencode: null, go: key ? { type: "key", key } : null };
  }
  const credentials = await exportCredentials(install);
  const selected = (integrationID: string) => {
    const entry = credentials.find((item) => item.integrationID === integrationID && item.active);
    return entry ? goCredential(integrationID, entry.value) : null;
  };
  return { opencode: selected("opencode"), go: selected("opencode-go") };
}

async function readFileKey(path: string): Promise<string | null> {
  try {
    const auth = fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

async function exportCredentials(install: OpenCodeInstall) {
  try {
    const { stdout } = await execCommand(
      install.command,
      // Without --standalone the command starts OpenCode's background service and leaves it running.
      [...install.args, "auth", "export", "--standalone"],
      { env: install.env, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return exportSchema.parse(JSON.parse(stdout));
  } catch {
    // The command's output holds every secret, so its error is not passed on.
    throw new Error("OpenCode could not list its logins. OpenCode 2.0.20 or newer is required.");
  }
}

function goCredential(integrationID: string, value: unknown): GoCredential | null {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) return null;
  const { data } = parsed;
  // A credential for another Console never goes to opencode.ai.
  if (consoleServer(data.metadata?.server) !== CONSOLE_SERVER) return null;
  if (data.type === "key") return { type: "key", key: data.key };
  const orgID = data.metadata?.orgID;
  if (integrationID !== "opencode" || !orgID || !ORGANIZATION_ID.test(orgID)) return null;
  return { type: "console", access: data.access, expires: data.expires, orgID };
}

// OpenCode defaults a missing server to the Console and maps the retired host onto it.
function consoleServer(server: string | undefined): string {
  return (server ?? CONSOLE_SERVER).replace(
    /^https:\/\/console\.opencode\.ai(?=\/|$)/,
    CONSOLE_SERVER,
  );
}
