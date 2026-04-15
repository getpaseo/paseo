// Task name generation — adapted from emdash's taskNames.ts

const ADJECTIVES = [
  "curious",
  "brisk",
  "mellow",
  "vivid",
  "bright",
  "calm",
  "daring",
  "eager",
  "gentle",
  "keen",
  "lively",
  "nimble",
  "quiet",
  "rapid",
  "steady",
  "swift",
  "tidy",
  "bold",
  "clever",
  "fresh",
] as const;

const NOUNS = [
  "branch",
  "pixel",
  "thread",
  "anchor",
  "beacon",
  "circuit",
  "delta",
  "ember",
  "harbor",
  "lantern",
  "meadow",
  "moment",
  "quill",
  "signal",
  "spark",
  "stride",
  "trail",
  "vector",
  "weave",
  "whisper",
] as const;

export const MAX_TASK_NAME_LENGTH = 64;

export function normalizeTaskName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TASK_NAME_LENGTH);
}

export function ensureUniqueTaskName(
  baseName: string,
  existingNames: Iterable<string>,
  maxAttempts = 6,
): string {
  const normalizedExisting = new Set(
    Array.from(existingNames, (name) => normalizeTaskName(name)).filter(Boolean),
  );
  const base = normalizeTaskName(baseName);
  if (base && !normalizedExisting.has(base)) return base;

  for (let i = 2; i < 2 + maxAttempts; i++) {
    const candidate = normalizeTaskName(`${baseName}-${i}`);
    if (candidate && !normalizedExisting.has(candidate)) {
      return candidate;
    }
  }

  const fallback = normalizeTaskName(`${baseName}-${Date.now().toString(36)}`);
  return fallback || base;
}

function pick(list: readonly string[], rnd: () => number): string {
  return list[Math.floor(rnd() * list.length)] || "";
}

export function generateFriendlyTaskName(
  existingNames: Iterable<string> = [],
  options?: { seed?: number },
): string {
  const taken = new Set(
    Array.from(existingNames || [], (n) => normalizeTaskName(n)).filter(Boolean),
  );

  let currentSeed = options?.seed ?? Math.random();
  const rng = () => {
    currentSeed = (currentSeed * 9301 + 49297) % 233280;
    return currentSeed / 233280;
  };

  for (let i = 0; i < 8; i++) {
    const candidate = `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}`;
    const normalized = normalizeTaskName(candidate);
    if (normalized && !taken.has(normalized)) {
      return candidate;
    }
  }

  return ensureUniqueTaskName("task", existingNames);
}
