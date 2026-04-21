import type { CatalogItem, CatalogPage } from "./types";

const SKILLS_SH_SEARCH = "https://skills.sh/api/search";

interface SkillsShResult {
  id: string;
  skillId: string;
  name: string;
  installs?: number;
  source?: string; // "<owner>/<repo>"
}

interface SkillsShResponse {
  query?: string;
  searchType?: string;
  skills?: SkillsShResult[];
}

/**
 * Common folder layouts repos use for SKILL.md. Probed in order until one
 * returns 200. Saves a recursive GH tree call on the hot path.
 */
const SKILL_PATH_TEMPLATES = [
  "skills/{id}/SKILL.md",
  ".skills/{id}/SKILL.md",
  ".agents/skills/{id}/SKILL.md",
  "{id}/SKILL.md",
];

/**
 * Search the public skills.sh index. Requires `query.length >= 2` (their
 * server enforces this — we short-circuit). Returns lightweight items;
 * `instructionsUrl` is the *first probed* raw URL — it may 404, in which
 * case `resolveSkillRawUrl` is the fallback used at body-fetch time.
 */
export async function fetchSkillsShSearch(query: string): Promise<CatalogPage> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { items: [], nextCursor: null, totalCount: 0 };

  const url = `${SKILLS_SH_SEARCH}?q=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`skills.sh ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as SkillsShResponse;
  const items: CatalogItem[] = (body.skills ?? [])
    .filter((s) => s.source && s.source.includes("/"))
    .map((s) => normalizeSkill(s));

  return { items, nextCursor: null, totalCount: items.length };
}

function normalizeSkill(raw: SkillsShResult): CatalogItem {
  const [owner, repo] = (raw.source ?? "").split("/", 2);
  const id = `skills-sh:${raw.id}`;
  return {
    id,
    kind: "skill",
    name: humanize(raw.name),
    description: "",
    iconUrl: owner
      ? `https://avatars.githubusercontent.com/${owner}`
      : null,
    homepage: `https://skills.sh/s/${encodeURIComponent(raw.id)}`,
    instructionsUrl:
      owner && repo
        ? buildRawUrl(owner, repo, SKILL_PATH_TEMPLATES[0]!.replace("{id}", raw.skillId))
        : undefined,
    popularity: raw.installs ?? 0,
    source: "skills-sh",
  };
}

function buildRawUrl(owner: string, repo: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Resolve a skills.sh entry's actual raw SKILL.md URL by probing the common
 * folder templates. Returns the first URL that returns 200, or null when
 * none match. Used by the detail body fetch as a fallback to the optimistic
 * `instructionsUrl` set during normalization.
 */
export async function resolveSkillRawUrl(
  source: string,
  skillId: string,
): Promise<string | null> {
  const [owner, repo] = source.split("/", 2);
  if (!owner || !repo) return null;
  for (const template of SKILL_PATH_TEMPLATES) {
    const url = buildRawUrl(owner, repo, template.replace("{id}", skillId));
    try {
      const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
      if (head.ok) return url;
    } catch {
      /* probe next */
    }
  }
  return null;
}
