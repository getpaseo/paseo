import type { CatalogItem, CatalogPage } from "./types";

const REPOS = [
  { owner: "anthropics", repo: "skills", source: "anthropic-skills" as const },
  { owner: "openai", repo: "skills", source: "openai-skills" as const },
];

interface GhTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

interface GhTreeResponse {
  tree?: GhTreeItem[];
  truncated?: boolean;
}

/**
 * List every SKILL.md across each known skills repo, then enrich each entry
 * with its frontmatter `description`. The frontmatter fetch costs N small
 * raw.githubusercontent.com requests (one per skill, in parallel) and only
 * happens on cache miss — the wrapped catalog cache holds the result for
 * 24h so the cost amortizes to ~zero.
 */
export async function fetchGithubSkills(): Promise<CatalogPage> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const items: CatalogItem[] = [];
  for (const repo of REPOS) {
    try {
      const treeUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/HEAD?recursive=1`;
      const res = await fetch(treeUrl, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[catalog] ${repo.owner}/${repo.repo} tree ${res.status}`);
        continue;
      }
      const body = (await res.json()) as GhTreeResponse;
      for (const entry of body.tree ?? []) {
        if (entry.type !== "blob") continue;
        if (!entry.path.endsWith("/SKILL.md")) continue;
        const parts = entry.path.split("/");
        const skillName = parts[parts.length - 2];
        if (!skillName) continue;
        const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${entry.path}`;
        items.push({
          id: `${repo.source}:${skillName}`,
          kind: "skill",
          name: humanize(skillName),
          description: "", // filled in below from SKILL.md frontmatter
          iconUrl: `https://avatars.githubusercontent.com/${repo.owner}`,
          homepage: `https://github.com/${repo.owner}/${repo.repo}/tree/HEAD/${parts.slice(0, -1).join("/")}`,
          instructionsUrl: rawUrl,
          source: repo.source,
        });
      }
    } catch (err) {
      console.warn(`[catalog] ${repo.owner}/${repo.repo} fetch failed`, err);
    }
  }

  await enrichWithFrontmatter(items);
  return { items, nextCursor: null, totalCount: items.length };
}

async function enrichWithFrontmatter(items: CatalogItem[]): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      if (!item.instructionsUrl) return;
      try {
        const res = await fetch(item.instructionsUrl, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const text = await res.text();
        const meta = parseFrontmatter(text);
        if (meta.description) item.description = meta.description;
        if (meta.name) item.name = meta.name;
      } catch {
        /* leave description empty; UI hides empty descriptions */
      }
    }),
  );
}

/**
 * Pull the YAML frontmatter block from the top of a SKILL.md. Anthropic's
 * convention is `name:` and `description:` on their own lines. We don't pull
 * in a full YAML parser because the schema is intentionally tiny.
 */
function parseFrontmatter(source: string): { name?: string; description?: string } {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = source.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(name|description):\s*(.+)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as "name" | "description"] = value;
  }
  return out;
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Fetch a single skill's SKILL.md body. Used by the detail modal.
 */
export async function fetchSkillBody(rawUrl: string): Promise<string | null> {
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
