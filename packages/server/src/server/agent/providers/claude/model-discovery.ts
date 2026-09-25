import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import { resolvePaseoHome } from "../../../paseo-home.js";
import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import { getClaudeCustomModelThinkingOptions, isClaudeManifestModelId } from "./model-manifest.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
export const CLAUDE_MODEL_DISCOVERY_ENV = "PASEO_CLAUDE_MODEL_DISCOVERY";

// Only alias spellings are offered; dated variants (claude-*-YYYYMMDD) collapse
// onto their alias in the picker and would duplicate it.
const CLAUDE_MODEL_ALIAS_PATTERN = /^claude-(?:fable|opus|sonnet|haiku)-\d+(?:-\d{1,2})?$/;

export interface ClaudeModelDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface DiscoveryCache {
  fetchedAt: number;
  models: unknown;
}

/**
 * Anthropic models published on models.dev that the compiled manifest does not
 * know yet, so a new release is selectable before a Paseo update ships. The
 * manifest always wins: anything it already spells (including version-gated
 * entries) keeps its curated capabilities instead of a guessed definition.
 * Never throws — discovery failure leaves the manifest-only status quo.
 */
export async function fetchDiscoveredClaudeModels(
  logger: Logger,
  options: ClaudeModelDiscoveryOptions = {},
): Promise<AgentModelDefinition[]> {
  const env = options.env ?? process.env;
  if (/^(off|false|0)$/i.test(env[CLAUDE_MODEL_DISCOVERY_ENV] ?? "")) {
    return [];
  }
  const cacheFile =
    options.cacheFile ?? path.join(resolvePaseoHome(env), "cache", "claude-models.json");

  const cached = await readDiscoveryCache(logger, cacheFile);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return toModelDefinitions(cached.models);
  }

  let models: unknown;
  try {
    models = await fetchAnthropicModels(options);
  } catch (error) {
    logger.warn({ err: error }, "Claude model discovery failed; using cached or manifest models");
    return cached ? toModelDefinitions(cached.models) : [];
  }
  try {
    await writeDiscoveryCache(cacheFile, { fetchedAt: now, models });
  } catch (error) {
    logger.debug({ err: error, cacheFile }, "Could not persist the Claude model discovery cache");
  }
  return toModelDefinitions(models);
}

async function fetchAnthropicModels(options: ClaudeModelDiscoveryOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (options.signal) {
    signals.push(options.signal);
  }
  const response = await fetchImpl(options.apiUrl ?? MODELS_DEV_API_URL, {
    signal: AbortSignal.any(signals),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`models.dev responded ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.anthropic) || !isRecord(payload.anthropic.models)) {
    throw new Error("models.dev payload has no anthropic models map");
  }
  return payload.anthropic.models;
}

function toModelDefinitions(models: unknown): AgentModelDefinition[] {
  if (!isRecord(models)) {
    return [];
  }
  const definitions: AgentModelDefinition[] = [];
  for (const [id, entry] of Object.entries(models)) {
    // Exact-id match only: fuzzy normalization maps a new minor (claude-opus-5-6)
    // onto a known major (claude-opus-5) and would drop the release discovery
    // exists to surface. Gated manifest entries stay gated either way.
    if (!CLAUDE_MODEL_ALIAS_PATTERN.test(id) || isClaudeManifestModelId(id)) {
      continue;
    }
    const record = isRecord(entry) ? entry : {};
    const limit = isRecord(record.limit) ? record.limit : {};
    const definition: AgentModelDefinition = {
      provider: "claude",
      id,
      label:
        typeof record.name === "string" && record.name.trim().length > 0
          ? record.name.replace(/^Claude\s+/, "")
          : id,
      description:
        typeof record.description === "string" && record.description.trim().length > 0
          ? record.description
          : "Discovered from models.dev",
      thinkingOptions: getClaudeCustomModelThinkingOptions(),
    };
    if (typeof limit.context === "number" && limit.context > 0) {
      definition.contextWindowMaxTokens = limit.context;
    }
    definitions.push(definition);
  }
  return definitions;
}

/**
 * A model id that settings.json or another config source already offers stays
 * a single row: the configured row keeps its identity, and the discovered row
 * fills in the capabilities a configured row does not carry.
 */
export function mergeDiscoveredClaudeModels(
  models: AgentModelDefinition[],
  discovered: AgentModelDefinition[],
): AgentModelDefinition[] {
  const merged = [...models];
  const indexById = new Map(models.map((model, index) => [model.id, index]));
  for (const row of discovered) {
    const existingIndex = indexById.get(row.id);
    if (existingIndex === undefined) {
      merged.push(row);
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...row,
      ...existing,
      thinkingOptions: existing.thinkingOptions ?? row.thinkingOptions,
      contextWindowMaxTokens: existing.contextWindowMaxTokens ?? row.contextWindowMaxTokens,
    };
  }
  return merged;
}

async function readDiscoveryCache(
  logger: Logger,
  cacheFile: string,
): Promise<DiscoveryCache | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error, cacheFile }, "Could not read the Claude model discovery cache");
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.fetchedAt === "number") {
      return { fetchedAt: parsed.fetchedAt, models: parsed.models };
    }
    logger.warn({ cacheFile }, "Claude model discovery cache has an unexpected shape");
  } catch (error) {
    logger.warn({ err: error, cacheFile }, "Claude model discovery cache is not valid JSON");
  }
  return null;
}

async function writeDiscoveryCache(cacheFile: string, cache: DiscoveryCache): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
  await fs.rename(temporary, cacheFile);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
