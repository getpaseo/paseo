import { readAuth, type StoreLookup } from "./stores.js";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { AntigravityUsageInput } from "../shared/input.js";

const loadCodeAssistSchema = z.object({
  currentTier: z.object({ id: z.string().optional() }).optional(),
  paidTier: z.object({ id: z.string().optional() }).optional(),
  allowedTiers: z.array(z.object({ id: z.string().optional() })).optional(),
  cloudaicompanionProject: z.union([z.string(), z.object({ id: z.string().optional() })]).nullish(),
});

const userQuotaBucketSchema = z.object({
  bucketId: z.string().optional(),
  id: z.string().optional(),
  displayName: z.string().optional(),
  name: z.string().optional(),
  window: z.string().optional(),
  resetTime: z.string().nullish(),
  reset_time: z.string().nullish(),
  description: z.string().optional(),
  remainingFraction: z.number().nullish(),
  remaining_fraction: z.number().nullish(),
});

const userQuotaGroupSchema = z.object({
  displayName: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(userQuotaBucketSchema).optional(),
});

const retrieveUserQuotaSummarySchema = z.object({
  groups: z.array(userQuotaGroupSchema).optional(),
});

const modelQuotaSchema = z.object({
  displayName: z.string().optional(),
  model: z.string().optional(),
  quotaInfo: z
    .object({
      remainingFraction: z.number().nullish(),
      resetTime: z.string().nullish(),
    })
    .nullish(),
});

const fetchAvailableModelsSchema = z.object({
  models: z.record(z.string(), modelQuotaSchema).nullish(),
});

export const CLOUDCODE_BASE_URL = "https://cloudcode-pa.googleapis.com";
export const DEFAULT_PROJECT_ID = "aicode-consumers";

export function formatPlanLabel(rawTierId?: string): string | undefined {
  if (!rawTierId) return undefined;
  const cleaned = rawTierId
    .replace(/-tier$/i, "")
    .replace(/-/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function buildUserAgent(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  let osName = "linux";
  if (platform === "darwin") {
    osName = "darwin";
  } else if (platform === "win32") {
    osName = "windows";
  }
  return `antigravity/1.107.0 ${osName}/${arch}`;
}

export const DEFAULT_USER_AGENT = buildUserAgent();

interface CodeAssistResult {
  rejectedStatus?: number;
  projectId: string;
  planLabel?: string;
}

function parseCodeAssistData(text: string): { planLabel?: string; projectId?: string } {
  const json = JSON.parse(text);
  const assist = loadCodeAssistSchema.parse(json);

  const planLabel = assist.currentTier?.id ?? assist.paidTier?.id ?? assist.allowedTiers?.[0]?.id;

  const compProject = assist.cloudaicompanionProject;
  let projectId: string | undefined;
  if (typeof compProject === "string" && compProject.length > 0) {
    projectId = compProject;
  } else if (typeof compProject === "object" && compProject?.id) {
    projectId = compProject.id;
  }

  return { planLabel, projectId };
}

async function resolveCodeAssist(
  fetchApi: typeof fetch,
  headers: Record<string, string>,
  lookup: StoreLookup = {},
): Promise<CodeAssistResult> {
  const platform = lookup.platform ?? process.platform;
  const metadataPlatform = platform === "darwin" ? "DARWIN_ARM64" : "LINUX_AMD64";
  const metadata = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: "1.107.0",
    platform: metadataPlatform,
    pluginType: "GEMINI",
  };

  const assistResponse = await fetchApi(`${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "FULL_ELIGIBILITY_CHECK",
      metadata,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (assistResponse.status === 401 || assistResponse.status === 403) {
    return { rejectedStatus: assistResponse.status, projectId: DEFAULT_PROJECT_ID };
  }

  if (!assistResponse.ok) {
    throw new Error(`Antigravity account API returned ${assistResponse.status}`);
  }

  const text = await assistResponse.text();
  if (text.trim().startsWith("<")) {
    throw new Error("Antigravity account API returned HTML");
  }

  const parsed = parseCodeAssistData(text);
  return {
    projectId: parsed.projectId ?? DEFAULT_PROJECT_ID,
    planLabel: parsed.planLabel,
  };
}

function getGroupInfo(displayName?: string): { prefix: string; short: string; id: string } {
  const name = displayName ?? "";
  if (/argon/i.test(name)) {
    return {
      prefix: "Gemini 4 Argon",
      short: "Argon",
      id: "gemini-argon",
    };
  }
  if (/gemini/i.test(name)) {
    return {
      prefix: "Gemini",
      short: "Gemini",
      id: "gemini",
    };
  }
  return {
    prefix: "Claude & GPT-OSS",
    short: "Claude/OSS",
    id: "claude-gpt-oss",
  };
}

function buildSummaryWindows(groups: z.infer<typeof userQuotaGroupSchema>[]): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const group of groups) {
    const groupName = group.displayName ?? group.name ?? "";
    const { prefix: groupPrefix, short: groupShort, id: idPrefix } = getGroupInfo(groupName);

    for (const bucket of group.buckets ?? []) {
      const remainingFraction = bucket.remainingFraction ?? bucket.remaining_fraction;
      if (remainingFraction == null) continue;

      const bucketId = bucket.bucketId ?? bucket.id ?? "";
      const bucketName = bucket.displayName ?? bucket.name ?? "";
      const windowStr = bucket.window ?? "";

      const isWeekly =
        /week/i.test(windowStr) || /week/i.test(bucketId) || /week/i.test(bucketName);
      const windowId = isWeekly ? `${idPrefix}-weekly` : `${idPrefix}-5h`;
      const label = `${groupPrefix} \u00b7 ${isWeekly ? "Weekly" : "5h"}`;
      const shortLabel = `${groupShort} ${isWeekly ? "wk" : "5h"}`;
      const summary = isWeekly;

      const utilizationPct = Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)));

      const resetTime = bucket.resetTime ?? bucket.reset_time ?? null;

      windows.push(
        windowFromUsedPct({
          id: windowId,
          label,
          shortLabel,
          summary,
          utilizationPct,
          resetsAt: resetTime,
          tone: toneFromUsedPct(utilizationPct),
        }),
      );
    }
  }

  return windows;
}

interface ModelCandidate {
  modelId: string;
  displayName: string;
  remainingFraction: number;
  resetTime: string | null;
}

const BUCKET_DEFS = [
  {
    id: "gemini",
    label: "Gemini (all models)",
    shortLabel: "Gemini",
    isMember: (modelId: string, displayName: string) =>
      !/argon/i.test(modelId) &&
      !/argon/i.test(displayName) &&
      (modelId.toLowerCase().startsWith("gemini") ||
        displayName.toLowerCase().startsWith("gemini")),
  },
  {
    id: "gemini-argon",
    label: "Gemini 4 Argon (all models)",
    shortLabel: "Argon",
    isMember: (modelId: string, displayName: string) =>
      /argon/i.test(modelId) || /argon/i.test(displayName),
  },
  {
    id: "claude-gpt-oss",
    label: "Claude & GPT-OSS (all models)",
    shortLabel: "Claude/OSS",
    isMember: (modelId: string, displayName: string) =>
      !modelId.toLowerCase().startsWith("gemini") &&
      !displayName.toLowerCase().startsWith("gemini"),
  },
] as const;

function buildWindows(models: Record<string, z.infer<typeof modelQuotaSchema>>): UsageWindow[] {
  const candidates: ModelCandidate[] = [];

  for (const [modelId, info] of Object.entries(models)) {
    const quota = info.quotaInfo;
    if (!quota || quota.remainingFraction == null) continue;
    if (!info.displayName || /^(chat_\d+|tab_)/.test(modelId)) continue;

    candidates.push({
      modelId,
      displayName: info.displayName.trim(),
      remainingFraction: quota.remainingFraction,
      resetTime: quota.resetTime ?? null,
    });
  }

  const windows: UsageWindow[] = [];

  for (const bucket of BUCKET_DEFS) {
    const members = candidates.filter((c) => bucket.isMember(c.modelId, c.displayName));
    if (members.length === 0) continue;

    members.sort((a, b) => {
      if (a.remainingFraction !== b.remainingFraction) {
        return a.remainingFraction - b.remainingFraction;
      }
      if (a.resetTime && b.resetTime) {
        return a.resetTime.localeCompare(b.resetTime);
      }
      return a.resetTime ? -1 : 1;
    });

    const representative = members[0];
    const utilizationPct = Math.max(
      0,
      Math.min(100, Math.round((1 - representative.remainingFraction) * 100)),
    );

    windows.push(
      windowFromUsedPct({
        id: bucket.id,
        label: bucket.label,
        shortLabel: bucket.shortLabel,
        summary: true,
        utilizationPct,
        resetsAt: representative.resetTime,
        tone: toneFromUsedPct(utilizationPct),
      }),
    );
  }

  return windows;
}

interface QuotaSummaryResult {
  rejectedStatus?: number;
  windows?: UsageWindow[];
}

async function resolveUserQuotaSummary(
  fetchApi: typeof fetch,
  headers: Record<string, string>,
): Promise<QuotaSummaryResult> {
  try {
    const summaryResponse = await fetchApi(
      `${CLOUDCODE_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      return { rejectedStatus: summaryResponse.status };
    }

    if (!summaryResponse.ok) return {};

    const summaryText = await summaryResponse.text();
    if (summaryText.trim().startsWith("<")) return {};

    const parsedSummary = retrieveUserQuotaSummarySchema.safeParse(JSON.parse(summaryText));
    if (
      !parsedSummary.success ||
      !parsedSummary.data.groups ||
      parsedSummary.data.groups.length === 0
    ) {
      return {};
    }

    const windows = buildSummaryWindows(parsedSummary.data.groups);
    if (windows.length > 0) {
      return { windows };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw error;
    }
  }
  return {};
}

interface AvailableModelsResult {
  rejectedStatus?: number;
  windows?: UsageWindow[];
}

async function resolveAvailableModels(
  fetchApi: typeof fetch,
  headers: Record<string, string>,
  projectId: string,
): Promise<AvailableModelsResult> {
  const modelsResponse = await fetchApi(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: projectId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (modelsResponse.status === 401 || modelsResponse.status === 403) {
    return { rejectedStatus: modelsResponse.status };
  }

  if (!modelsResponse.ok) {
    throw new Error(`Antigravity usage API returned ${modelsResponse.status}`);
  }

  const modelsText = await modelsResponse.text();
  if (modelsText.trim().startsWith("<")) {
    throw new Error("Antigravity usage API returned HTML");
  }

  const parsed = fetchAvailableModelsSchema.parse(JSON.parse(modelsText));
  return { windows: buildWindows(parsed.models ?? {}) };
}

export async function fetchUsage(
  input: AntigravityUsageInput,
  fetchApi: typeof fetch = fetch,
  lookup: StoreLookup = {},
): Promise<UsageReport> {
  const auth = await readAuth(input, lookup);
  if (!auth) throw new Error("Antigravity login store no longer exists");

  const refreshedBy = "agy";
  const now = (lookup.now ?? Date.now)();

  if (auth.expires !== undefined && auth.expires <= now) {
    return unavailable({
      kind: "expired",
      expiresAt: new Date(auth.expires).toISOString(),
      refreshedBy,
    });
  }

  const userAgent = buildUserAgent(lookup.platform, process.arch);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };

  const assistResult = await resolveCodeAssist(fetchApi, headers, lookup);
  if (assistResult.rejectedStatus !== undefined) {
    return unavailable({ kind: "rejected", status: assistResult.rejectedStatus, refreshedBy });
  }

  const planLabel = formatPlanLabel(assistResult.planLabel);

  const summaryResult = await resolveUserQuotaSummary(fetchApi, headers);
  if (summaryResult.rejectedStatus !== undefined) {
    return unavailable({ kind: "rejected", status: summaryResult.rejectedStatus, refreshedBy });
  }
  if (summaryResult.windows && summaryResult.windows.length > 0) {
    return {
      status: "available",
      planLabel,
      windows: summaryResult.windows,
      balances: [],
      details: [],
    };
  }

  // Fallback: fetchAvailableModels
  const modelsResult = await resolveAvailableModels(fetchApi, headers, assistResult.projectId);
  if (modelsResult.rejectedStatus !== undefined) {
    return unavailable({ kind: "rejected", status: modelsResult.rejectedStatus, refreshedBy });
  }

  return {
    status: "available",
    planLabel,
    windows: modelsResult.windows ?? [],
    balances: [],
    details: [],
  };
}
