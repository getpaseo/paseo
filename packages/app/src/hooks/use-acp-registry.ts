import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import type { MutableDaemonConfigPatch } from "@server/shared/messages";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_RAW_REGISTRY_BASE =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main";

const NpxDistributionSchema = z
  .object({
    package: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();

const BinaryDistributionSchema = z
  .record(
    z
      .object({
        archive: z.string(),
        cmd: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        sha256: z.string().optional(),
      })
      .passthrough(),
  )
  .optional();

const RegistryEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional().default(""),
    version: z.string(),
    repository: z.string().optional(),
    website: z.string().optional(),
    icon: z.string().optional(),
    icon_path: z.string().optional(),
    distribution: z
      .object({
        npx: NpxDistributionSchema.optional(),
        binary: BinaryDistributionSchema,
      })
      .passthrough()
      .optional(),
    npx: NpxDistributionSchema.optional(),
    binary: BinaryDistributionSchema,
  })
  .passthrough();

const RegistrySchema = z
  .object({
    agents: z.array(RegistryEntrySchema).optional(),
  })
  .passthrough();

export interface AcpRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  repository?: string;
  website?: string;
  iconUri: string | null;
  npx?: z.infer<typeof NpxDistributionSchema>;
  binary?: z.infer<typeof BinaryDistributionSchema>;
}

type AcpRegistryFetch = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

interface RegistryCacheEntry {
  expiresAt: number;
  promise: Promise<AcpRegistryEntry[]>;
}

const registryCache = new Map<string, RegistryCacheEntry>();

function resolveIconUri(entry: z.infer<typeof RegistryEntrySchema>): string | null {
  const icon = entry.icon ?? entry.icon_path;
  if (!icon) return null;
  if (/^https?:\/\//i.test(icon)) return icon;
  return `${GITHUB_RAW_REGISTRY_BASE}/${entry.id}/${icon.replace(/^\/+/, "")}`;
}

function normalizeRegistryEntry(entry: z.infer<typeof RegistryEntrySchema>): AcpRegistryEntry {
  const normalized: AcpRegistryEntry = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    iconUri: resolveIconUri(entry),
  };
  const npx = entry.distribution?.npx ?? entry.npx;
  const binary = entry.distribution?.binary ?? entry.binary;

  if (entry.repository) {
    normalized.repository = entry.repository;
  }
  if (entry.website) {
    normalized.website = entry.website;
  }
  if (npx) {
    normalized.npx = npx;
  }
  if (binary) {
    normalized.binary = binary;
  }

  return normalized;
}

export function parseAcpRegistry(payload: unknown): AcpRegistryEntry[] {
  if (Array.isArray(payload)) {
    return z.array(RegistryEntrySchema).parse(payload).map(normalizeRegistryEntry);
  }

  const parsed = RegistrySchema.parse(payload);
  const rawEntries = parsed.agents ?? [];
  return z.array(RegistryEntrySchema).parse(rawEntries).map(normalizeRegistryEntry);
}

export async function fetchAcpRegistryEntries(
  url: string,
  fetchRegistry: AcpRegistryFetch,
): Promise<AcpRegistryEntry[]> {
  const response = await fetchRegistry(url);
  if (!response.ok) {
    throw new Error(`Registry request failed with ${response.status}`);
  }
  return parseAcpRegistry(await response.json());
}

export function buildAcpProviderConfigPatch(entry: AcpRegistryEntry): MutableDaemonConfigPatch {
  if (!entry.npx) {
    throw new Error(`Provider ${entry.id} does not support NPX installation`);
  }

  return {
    providers: {
      [entry.id]: {
        extends: "acp",
        label: entry.name,
        description: entry.description,
        command: ["npx", "-y", entry.npx.package, ...(entry.npx.args ?? [])],
        env: entry.npx.env ?? {},
      },
    },
  };
}

function readRegistry(url: string): Promise<AcpRegistryEntry[]> {
  const now = Date.now();
  const cached = registryCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = fetchAcpRegistryEntries(url, fetch).catch((error) => {
    registryCache.delete(url);
    throw error;
  });
  registryCache.set(url, { expiresAt: now + CACHE_TTL_MS, promise });
  return promise;
}

export function useAcpRegistry(url = ACP_REGISTRY_URL) {
  const [entries, setEntries] = useState<AcpRegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false, isActive: () => boolean = () => true) => {
      if (force) {
        registryCache.delete(url);
      }
      setLoading(true);
      setError(null);
      try {
        const nextEntries = await readRegistry(url);
        if (isActive()) {
          setEntries(nextEntries);
        }
      } catch (nextError) {
        if (isActive()) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (isActive()) {
          setLoading(false);
        }
      }
    },
    [url],
  );

  useEffect(() => {
    let active = true;
    void load(false, () => active);
    return () => {
      active = false;
    };
  }, [load]);

  const refetch = useCallback(() => load(true), [load]);

  return { entries, loading, error, refetch };
}
