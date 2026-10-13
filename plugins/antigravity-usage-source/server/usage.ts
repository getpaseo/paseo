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
export const DEFAULT_USER_AGENT = "antigravity/1.107.0 linux/amd64";

interface CodeAssistResult {
  rejectedStatus?: number;
  projectId: string;
  planLabel?: string;
}

function parseCodeAssistData(text: string): { planLabel?: string; projectId?: string } {
  try {
    const assist = loadCodeAssistSchema.safeParse(JSON.parse(text));
    if (!assist.success) return {};

    const planLabel =
      assist.data.currentTier?.id ?? assist.data.paidTier?.id ?? assist.data.allowedTiers?.[0]?.id;

    const compProject = assist.data.cloudaicompanionProject;
    let projectId: string | undefined;
    if (typeof compProject === "string" && compProject.length > 0) {
      projectId = compProject;
    } else if (typeof compProject === "object" && compProject?.id) {
      projectId = compProject.id;
    }

    return { planLabel, projectId };
  } catch {
    return {};
  }
}

function isTimeoutOrAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    (error.cause instanceof Error && error.cause.name === "TimeoutError")
  );
}

async function resolveCodeAssist(
  fetchApi: typeof fetch,
  headers: Record<string, string>,
): Promise<CodeAssistResult> {
  let projectId = DEFAULT_PROJECT_ID;
  let planLabel: string | undefined;

  const metadata = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: "1.107.0",
    platform: "LINUX_AMD64",
    pluginType: "GEMINI",
  };

  try {
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
      return { rejectedStatus: assistResponse.status, projectId };
    }

    if (assistResponse.ok) {
      const text = await assistResponse.text();
      const parsed = parseCodeAssistData(text);
      if (parsed.planLabel) planLabel = parsed.planLabel;
      if (parsed.projectId) projectId = parsed.projectId;
    }
  } catch (error) {
    if (isTimeoutOrAbort(error)) throw error;
  }

  return { projectId, planLabel };
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
      modelId.toLowerCase().startsWith("gemini") || displayName.toLowerCase().startsWith("gemini"),
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

    // Pick the most constrained quota (lowest remainingFraction, earliest resetTime)
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
  };

  const assistResult = await resolveCodeAssist(fetchApi, headers);
  if (assistResult.rejectedStatus !== undefined) {
    return unavailable({ kind: "rejected", status: assistResult.rejectedStatus, refreshedBy });
  }

  const modelsResponse = await fetchApi(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: assistResult.projectId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (modelsResponse.status === 401 || modelsResponse.status === 403) {
    return unavailable({ kind: "rejected", status: modelsResponse.status, refreshedBy });
  }

  if (!modelsResponse.ok) {
    throw new Error(`Antigravity usage API returned ${modelsResponse.status}`);
  }

  const modelsText = await modelsResponse.text();
  if (modelsText.trim().startsWith("<")) {
    throw new Error("Antigravity usage API returned HTML");
  }

  const parsed = fetchAvailableModelsSchema.parse(JSON.parse(modelsText));
  const windows = buildWindows(parsed.models ?? {});

  return {
    status: "available",
    planLabel: assistResult.planLabel,
    windows,
    balances: [],
    details: [],
  };
}
