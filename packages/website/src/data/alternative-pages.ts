export interface AlternativePage {
  slug: string;
  name: string;
  href: string;
  title: string;
  description: string;
  content: string;
  order: number;
}

function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    data[key] = value;
  }

  return { data, content: match[2] };
}

const alternativeModules = import.meta.glob("../content/alternatives/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function loadAlternativePages(): AlternativePage[] {
  const pages: AlternativePage[] = [];

  for (const [path, raw] of Object.entries(alternativeModules)) {
    const fileName = path.split("/").pop() ?? "";
    const slug = fileName.replace(/\.md$/, "");
    const { data, content } = parseFrontmatter(raw);
    const order = Number.parseInt(data.order ?? "999", 10);

    pages.push({
      slug,
      name: data.nav ?? data.title ?? slug,
      href: `/alternatives/${slug}`,
      title: data.title ?? slug,
      description: data.description ?? "",
      content,
      order: Number.isFinite(order) ? order : 999,
    });
  }

  pages.sort((a, b) => a.order - b.order);
  return pages;
}

let cached: AlternativePage[] | undefined;

export function getAlternativePages(): AlternativePage[] {
  if (!cached) cached = loadAlternativePages();
  return cached;
}

export function getAlternativePage(slug: string): AlternativePage | undefined {
  return getAlternativePages().find((p) => p.slug === slug);
}

export const ALTERNATIVE_PAGE_SLUGS: readonly string[] = getAlternativePages().map((p) => p.slug);
