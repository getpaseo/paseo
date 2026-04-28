interface PostFrontmatter {
  title: string;
  description: string;
  date: string;
  draft: boolean;
}

export interface Post {
  slug: string;
  frontmatter: PostFrontmatter;
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

const postModules = import.meta.glob("../posts/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function loadPosts(includeDrafts: boolean): Post[] {
  const posts: Post[] = [];

  for (const [path, raw] of Object.entries(postModules)) {
    const { data, content } = parseFrontmatter(raw);
    const isDraft = path.includes("/drafts/") || data.draft === "true";
    if (isDraft && !includeDrafts) continue;

    const fileName = path.split("/").pop()!.replace(".md", "");
    const slug = isDraft ? `drafts/${fileName}` : fileName;

    posts.push({
      slug,
      frontmatter: {
        title: data.title ?? "",
        description: data.description ?? "",
        date: data.date ?? "",
        draft: isDraft,
      },
      content,
    });
  }

  posts.sort(
    (a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime(),
  );

  return posts;
}

export function getPosts(includeDrafts = false): Post[] {
  return loadPosts(includeDrafts);
}

export function getPost(slug: string): Post | undefined {
  return loadPosts(true).find((p) => p.slug === slug);
}

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
