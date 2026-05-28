interface DocFrontmatter {
  title: string;
  description: string;
  nav: string;
  order: number;
}

export interface Doc {
  slug: string;
  href: string;
  sourcePath: string;
  frontmatter: DocFrontmatter;
  content: string;
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

const docModules = import.meta.glob("../../../public-docs/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function pathToSlug(path: string): string {
  const after = path.split("/public-docs/")[1] ?? path;
  const noExt = after.replace(/\.md$/, "");
  return noExt === "index" ? "" : noExt;
}

function pathToSourcePath(path: string): string {
  return path.split("/public-docs/")[1] ?? path;
}

function loadDocs(): Doc[] {
  const docs: Doc[] = [];

  for (const [path, raw] of Object.entries(docModules)) {
    const { data, content } = parseFrontmatter(raw);
    const slug = pathToSlug(path);
    const href = slug === "" ? "/docs" : `/docs/${slug}`;
    const order = Number.parseInt(data.order ?? "999", 10);

    docs.push({
      slug,
      href,
      sourcePath: `public-docs/${pathToSourcePath(path)}`,
      frontmatter: {
        title: data.title ?? "",
        description: data.description ?? "",
        nav: data.nav ?? data.title ?? slug,
        order: Number.isFinite(order) ? order : 999,
      },
      content,
    });
  }

  docs.sort((a, b) => a.frontmatter.order - b.frontmatter.order);
  return docs;
}

let cached: Doc[] | undefined;

export function getDocs(): Doc[] {
  if (!cached) cached = loadDocs();
  return cached;
}

export function getDoc(slug: string): Doc | undefined {
  return getDocs().find((d) => d.slug === slug);
}
