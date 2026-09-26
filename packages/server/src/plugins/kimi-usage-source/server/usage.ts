import type { UsageInput } from "../shared/input.js";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

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
}): UsageWindow {
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

function kimiUsageWindowsFromPayload(payload: unknown): UsageWindow[] {
  const response = KimiUsageResponseSchema.parse(payload);
  const windows: UsageWindow[] = [];
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
      continue;
    }

    const limit = parsedLimit.data;
    const { fields, metadata } = limitFields(limit);
    if (!hasUsageData(fields)) {
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

type KimiAuth = z.infer<typeof KimiAuthSchema>;
type KimiCredentials = KimiAuth & { access_token: string };

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  void input;
  const homeDir = homedir();

  async function callUsageApi(token: string): Promise<Response> {
    return fetchApi(KIMI_USAGE_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }

  async function readCredentials(): Promise<KimiCredentials | null> {
    const environmentToken = process.env["KIMI_TOKEN"] || process.env["KIMI_API_KEY"];
    if (environmentToken) {
      return { access_token: environmentToken };
    }

    for (const path of credentialPaths()) {
      const credentials = await readCredentialFile(path);
      if (credentials?.access_token) {
        return { ...credentials, access_token: credentials.access_token };
      }
    }
    return null;
  }

  function credentialPaths(): string[] {
    const home = homeDir;
    return [
      join(
        process.env["KIMI_CODE_HOME"] || join(home, ".kimi-code"),
        "credentials",
        "kimi-code.json",
      ),
      join(home, ".kimi", "credentials", "kimi-code.json"),
    ];
  }

  async function readCredentialFile(path: string): Promise<KimiAuth | null> {
    if (!existsSync(path)) return null;
    try {
      return KimiAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }

  const credentials = await readCredentials();
  if (!credentials) return unavailableUsage();

  const res = await callUsageApi(credentials.access_token);

  if (!res.ok) {
    // Read-only on credentials; the Kimi CLI owns refresh. See docs/providers.md.

    return unavailableUsage();
  }

  const windows = kimiUsageWindowsFromPayload(await res.json());
  if (windows[0]) windows[0].headline = true;

  return {
    account: { key: "default" },
    status: "available",
    planLabel: undefined,
    windows,
    balances: [],
    details: [],
  };
}
