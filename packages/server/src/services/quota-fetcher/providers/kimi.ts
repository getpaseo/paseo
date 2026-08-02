import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";

const KimiUsageFieldsSchema = z.object({
  limit: ApiOptionalStringSchema,
  used: ApiOptionalStringSchema,
  remaining: ApiOptionalStringSchema,
  resetTime: ApiOptionalStringSchema,
  resetAt: ApiOptionalStringSchema,
  reset_time: ApiOptionalStringSchema,
  reset_at: ApiOptionalStringSchema,
  name: ApiOptionalStringSchema,
  title: ApiOptionalStringSchema,
  scope: ApiOptionalStringSchema,
  duration: z.unknown().optional(),
  timeUnit: ApiOptionalStringSchema,
});

const KimiUsageLimitSchema = z
  .object({
    window: z.unknown().optional(),
    detail: z.unknown().optional(),
  })
  .passthrough();

const KimiUsageResponseSchema = z.object({
  usage: z.unknown().nullish(),
  limits: z.unknown().nullish(),
});

type KimiUsageFields = z.infer<typeof KimiUsageFieldsSchema>;
type KimiUsageLimit = z.infer<typeof KimiUsageLimitSchema>;

function parseUsageFields(value: unknown): KimiUsageFields | null {
  const parsed = KimiUsageFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function usedPctFromFields(fields: KimiUsageFields): number | null {
  const limit = fields.limit === undefined ? null : Number(fields.limit);
  const used = fields.used === undefined ? null : Number(fields.used);
  const remaining = fields.remaining === undefined ? null : Number(fields.remaining);

  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;

  let usedValue: number | null = null;
  if (used !== null && Number.isFinite(used)) {
    usedValue = used;
  } else if (remaining !== null && Number.isFinite(remaining)) {
    usedValue = limit - remaining;
  }

  return usedValue === null ? null : Math.max(0, Math.min(100, (usedValue / limit) * 100));
}

function resetTimeFromFields(fields: KimiUsageFields): string | null {
  return fields.resetTime ?? fields.resetAt ?? fields.reset_time ?? fields.reset_at ?? null;
}

function explicitUsageLabel(...fields: Array<KimiUsageFields | null>): string | null {
  for (const field of fields) {
    if (!field) continue;
    const label = field.name ?? field.title ?? field.scope;
    if (label?.trim()) return label.trim();
  }
  return null;
}

function durationFrom(value: unknown): number | null {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function durationLabel(duration: number, timeUnit: string | undefined): string | null {
  if (!timeUnit) return null;

  const normalizedUnit = timeUnit.replace(/^TIME_UNIT_/i, "").toUpperCase();
  if (normalizedUnit.includes("MINUTE")) {
    if (duration % 60 === 0) return `${duration / 60}-hour limit`;
    return `${duration}-minute limit`;
  }
  if (normalizedUnit.includes("HOUR")) return `${duration}-hour limit`;
  if (normalizedUnit.includes("DAY")) return `${duration}-day limit`;
  if (normalizedUnit.includes("WEEK")) return `${duration}-week limit`;
  if (normalizedUnit.includes("SECOND")) return `${duration}-second limit`;
  return null;
}

function idPart(value: string | number): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasUsageData(fields: KimiUsageFields | null): fields is KimiUsageFields {
  return (
    fields !== null &&
    (fields.limit !== undefined || fields.used !== undefined || fields.remaining !== undefined)
  );
}

function limitFields(limit: KimiUsageLimit): {
  fields: KimiUsageFields | null;
  metadata: KimiUsageFields | null;
} {
  const metadata = parseUsageFields(limit);
  const detail = parseUsageFields(limit.detail);
  return {
    fields: hasUsageData(detail) ? detail : metadata,
    metadata,
  };
}

function windowMetadata(limit: KimiUsageLimit): KimiUsageFields | null {
  return parseUsageFields(limit.window);
}

function limitIdentity(input: {
  metadata: KimiUsageFields | null;
  fields: KimiUsageFields;
  window: KimiUsageFields | null;
  index: number;
}): { id: string; label: string } {
  const label = explicitUsageLabel(input.metadata, input.fields);
  const duration = durationFrom(
    input.window?.duration ?? input.metadata?.duration ?? input.fields.duration,
  );
  const timeUnit = input.window?.timeUnit ?? input.metadata?.timeUnit ?? input.fields.timeUnit;
  const generatedLabel = duration === null ? null : durationLabel(duration, timeUnit);

  if (duration !== null && timeUnit) {
    return {
      id: `coding_limit_${idPart(duration)}_${idPart(timeUnit)}`,
      label: label ?? generatedLabel ?? `Limit ${input.index + 1}`,
    };
  }

  if (label) {
    return { id: `coding_limit_${idPart(label)}`, label };
  }

  return {
    id: `coding_limit_${input.index + 1}`,
    label: generatedLabel ?? `Limit ${input.index + 1}`,
  };
}

function windowFromFields(input: {
  id: string;
  label: string;
  fields: KimiUsageFields;
}): ProviderUsageWindow {
  const usedPct = usedPctFromFields(input.fields);
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: usedPct,
    resetsAt: resetTimeFromFields(input.fields),
    tone: toneFromUsedPct(usedPct),
  });
}

function uniqueWindowId(baseId: string, seenIds: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (seenIds.has(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  seenIds.add(id);
  return id;
}

function kimiUsageWindowsFromPayload(
  payload: unknown,
  logger: Pick<Logger, "debug">,
): ProviderUsageWindow[] {
  const response = KimiUsageResponseSchema.parse(payload);
  const windows: ProviderUsageWindow[] = [];
  const seenWindowIds = new Set<string>();
  const usage = parseUsageFields(response.usage);

  if (hasUsageData(usage)) {
    windows.push(
      windowFromFields({
        id: uniqueWindowId("coding_usage", seenWindowIds),
        label: explicitUsageLabel(usage) ?? "Weekly limit",
        fields: usage,
      }),
    );
  }

  const limits = Array.isArray(response.limits) ? response.limits : [];
  for (const [index, rawLimit] of limits.entries()) {
    const parsedLimit = KimiUsageLimitSchema.safeParse(rawLimit);
    if (!parsedLimit.success) {
      logger.debug({ index }, "Ignoring malformed Kimi usage limit window");
      continue;
    }

    const limit = parsedLimit.data;
    const { fields, metadata } = limitFields(limit);
    if (!hasUsageData(fields)) {
      logger.debug({ index }, "Ignoring malformed Kimi usage limit window");
      continue;
    }

    const window = windowMetadata(limit);
    const identity = limitIdentity({ metadata, fields, window, index });
    windows.push(
      windowFromFields({
        id: uniqueWindowId(identity.id, seenWindowIds),
        label: identity.label,
        fields,
      }),
    );
  }

  return windows;
}

const KimiAuthSchema = z
  .object({
    access_token: z.string().nullish(),
    refresh_token: z.string().nullish(),
    expires_at: ApiNumberSchema.nullish(),
    expires_in: ApiNumberSchema.nullish(),
    scope: z.string().nullish(),
    token_type: z.string().nullish(),
  })
  .passthrough();

const KimiTokenRefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: ApiNumberSchema.nullish(),
  scope: z.string().nullish(),
  token_type: z.string().nullish(),
});

type KimiAuth = z.infer<typeof KimiAuthSchema>;
type KimiTokenRefresh = z.infer<typeof KimiTokenRefreshSchema>;

interface KimiCredentialRecord {
  credentials: KimiAuth & { access_token: string };
  filePath: string | null;
}

interface SaveRefreshedCredentialsOptions {
  filePath: string;
  refreshTokenUsed: string;
  refreshed: KimiTokenRefresh;
}

interface KimiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

export class KimiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "kimi";
  readonly displayName = "Kimi";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir?: string;

  constructor(options: KimiQuotaProviderOptions) {
    this.logger = options.logger.child({ module: "kimi-quota-provider" });
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credentials = await this.readCredentials();
    if (!credentials) return unavailableUsage(this);

    const res = await this.fetchUsageResponse(credentials);

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi usage fetch failed");
      return unavailableUsage(this);
    }

    const windows = kimiUsageWindowsFromPayload(await res.json(), this.logger);

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }

  private async fetchUsageResponse(record: KimiCredentialRecord): Promise<Response> {
    const { credentials, filePath } = record;
    const res = await this.callUsageApi(credentials.access_token);

    if (res.status !== 401 || !filePath || !credentials.refresh_token) return res;

    const latest = await this.readCredentialFile(filePath);
    const retried =
      latest?.access_token && latest.access_token !== credentials.access_token
        ? await this.callUsageApi(latest.access_token)
        : res;
    if (retried.status !== 401) return retried;

    const refreshTokenUsed = latest?.refresh_token ?? credentials.refresh_token;
    const refreshed = await this.refreshToken(refreshTokenUsed);
    if (!refreshed) return retried;

    await this.saveRefreshedCredentials({ filePath, refreshTokenUsed, refreshed });
    return this.callUsageApi(refreshed.access_token);
  }

  private async callUsageApi(token: string): Promise<Response> {
    return fetchProviderApi(this.fetchApi, KIMI_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }

  private async refreshToken(refreshToken: string): Promise<KimiTokenRefresh | null> {
    const body = new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetchProviderApi(this.fetchApi, KIMI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi token refresh failed");
      return null;
    }
    const parsed = KimiTokenRefreshSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  }

  private async saveRefreshedCredentials(options: SaveRefreshedCredentialsOptions): Promise<void> {
    const { filePath, refreshTokenUsed, refreshed } = options;
    const existing = await this.readCredentialFile(filePath);
    if (!existing) return;

    // The Kimi CLI owns this file too. If its refresh token no longer matches the one we
    // just spent, the CLI rotated the credentials while our refresh was in flight and its
    // copy is newer than ours — writing our merge would strand the CLI on dead tokens.
    if (existing.refresh_token !== refreshTokenUsed) {
      this.logger.debug("Kimi credentials rotated during refresh; keeping the file on disk");
      return;
    }

    const expiresIn = refreshed.expires_in ?? existing.expires_in;
    const merged: KimiAuth = {
      ...existing,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? existing.refresh_token,
      expires_in: expiresIn,
      expires_at:
        expiresIn == null ? existing.expires_at : Math.floor(Date.now() / 1000) + expiresIn,
      scope: refreshed.scope ?? existing.scope,
      token_type: refreshed.token_type ?? existing.token_type,
    };

    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist refreshed Kimi credentials");
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async readCredentials(): Promise<KimiCredentialRecord | null> {
    const environmentToken = process.env["KIMI_TOKEN"] || process.env["KIMI_API_KEY"];
    if (environmentToken) {
      return { credentials: { access_token: environmentToken }, filePath: null };
    }

    for (const path of this.credentialPaths()) {
      const credentials = await this.readCredentialFile(path);
      if (credentials?.access_token) {
        return {
          credentials: { ...credentials, access_token: credentials.access_token },
          filePath: path,
        };
      }
    }
    return null;
  }

  private credentialPaths(): string[] {
    const homeDir = this.homeDir ?? homedir();
    return [
      join(
        process.env["KIMI_CODE_HOME"] || join(homeDir, ".kimi-code"),
        "credentials",
        "kimi-code.json",
      ),
      join(homeDir, ".kimi", "credentials", "kimi-code.json"),
    ];
  }

  private async readCredentialFile(path: string): Promise<KimiAuth | null> {
    if (!existsSync(path)) return null;
    try {
      return KimiAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
}
