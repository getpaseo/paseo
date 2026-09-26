import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { z } from "zod";
import type { UsageReference } from "../../agent-sdk-types.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";

const stickySchema = z.object({ type: z.string(), credentialId: z.number().int().positive() });
const rowSchema = z.object({
  id: z.number().int().positive(),
  provider: z.string(),
  credential_type: z.string(),
  data: z.string(),
  disabled_cause: z.string().nullable(),
});
const oauthSchema = z.object({
  access: z.string().min(1),
  expires: z.number(),
  accountId: z.string().optional(),
  orgId: z.string().optional(),
});
const configSchema = z
  .object({
    auth: z
      .object({ broker: z.object({ url: z.string().optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const modelsSchema = z
  .object({
    providers: z
      .record(z.string(), z.object({ apiKey: z.unknown().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

interface UsageDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}
const localRequire = createRequire(import.meta.url);
const yaml = localRequire("js-yaml") as { load(value: string): unknown };

function readYaml(file: string): unknown {
  try {
    return yaml.load(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function hasKeyOverride(provider: string, env: NodeJS.ProcessEnv, agentDir: string): boolean {
  // Upstream: packages/coding-agent/src/session/auth-broker-config.ts:9-16.
  const config = configSchema.safeParse(readYaml(join(agentDir, "config.yml")));
  if (env.OMP_AUTH_BROKER_URL || (config.success && config.data.auth?.broker?.url)) return true;
  // Upstream: packages/ai/src/auth/cascade.ts:22-84.
  const models = modelsSchema.safeParse(readYaml(join(agentDir, "models.yml")));
  return models.success && models.data.providers?.[provider]?.apiKey !== undefined;
}

function readCredential(db: UsageDb, provider: string, sessionId: string): unknown {
  // Upstream: packages/ai/src/auth/affinity.ts:83-88,115-132; sqlite-credential-store.ts:447-448,711-722.
  const cache = db
    .prepare(
      "SELECT value FROM cache WHERE key = ? AND expires_at > CAST(strftime('%s','now') AS INTEGER)",
    )
    .get(`session:sticky:${provider}:${sessionId}`) as { value?: unknown } | undefined;
  if (cache) {
    const sticky = stickySchema.safeParse(JSON.parse(String(cache.value)));
    if (!sticky.success || sticky.data.type !== "oauth") return null;
    return db
      .prepare(
        "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE id = ?",
      )
      .get(sticky.data.credentialId);
  }
  // Upstream: packages/ai/src/auth/cascade.ts:276-345 selects OAuth before env or stored API keys.
  const rows = db
    .prepare(
      "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL",
    )
    .all(provider);
  return rows.length === 1 ? rows[0] : null;
}

/** Read OMP's current credential attribution without changing its store. */
export function resolveOmpUsageReference(
  sessionId: string,
  provider: string,
  env: NodeJS.ProcessEnv,
): UsageReference | null {
  let source: string;
  if (provider === "openai-codex") source = "codex";
  else if (provider === "anthropic") source = "claude";
  else return null;
  if (!sessionId) return null;
  // Upstream: packages/utils/src/dirs.ts:82-94,330-343,583-585 (profile, override, agent dir).
  const paths = resolveOmpDiagnosticPaths(env);
  if (hasKeyOverride(provider, env, paths.agentDir)) return null;
  let db: UsageDb;
  try {
    const sqlite = localRequire("node:sqlite") as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => UsageDb;
    };
    db = new sqlite.DatabaseSync(paths.agentDb, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = rowSchema.safeParse(readCredential(db, provider, sessionId));
    if (
      !row.success ||
      row.data.provider !== provider ||
      row.data.credential_type !== "oauth" ||
      row.data.disabled_cause !== null
    )
      return null;
    // Upstream: packages/ai/src/auth/sqlite-credential-store.ts:117-155 stores OAuth data as JSON without type.
    const oauth = oauthSchema.safeParse(JSON.parse(row.data.data));
    if (!oauth.success || oauth.data.expires <= Date.now()) return null;
    return {
      source,
      input: {
        accessToken: oauth.data.access,
        ...(oauth.data.accountId ? { accountId: oauth.data.accountId } : {}),
      },
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
