import Slugger from "github-slugger";

interface DocFrontmatter {
  title: string;
  description: string;
  nav: string;
  order: number;
  category?: string;
}

export interface DocHeading {
  depth: number;
  text: string;
  id: string;
}

export interface Doc {
  slug: string;
  href: string;
  sourcePath: string;
  frontmatter: DocFrontmatter;
  content: string;
  headings: DocHeading[];
}

export type DocsNavNode =
  | {
      type: "category";
      label: string;
      children: DocsNavNode[];
      order: number;
    }
  | {
      type: "group";
      segment: string;
      label: string;
      children: DocsNavNode[];
      order: number;
    }
  | {
      type: "page";
      segment: string;
      label: string;
      href: string;
      order: number;
    };

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

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseHeadings(content: string): DocHeading[] {
  const slugger = new Slugger();
  const headings: DocHeading[] = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const depth = match[1].length;
    if (depth < 2 || depth > 4) continue;

    const text = stripInlineMarkdown(match[2].trim());
    if (!text) continue;

    headings.push({
      depth,
      text,
      id: slugger.slug(text),
    });
  }

  return headings;
}

const docModules = import.meta.glob("../../../public-docs/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function pathToSlug(path: string): string {
  const after = path.split("/public-docs/")[1] ?? path;
  const noExt = after.replace(/\.md$/, "");
  if (noExt === "index") return "";
  return noExt.replace(/\/index$/, "");
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
        category: data.category,
      },
      content,
      headings: parseHeadings(content),
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

function formatLabel(segment: string): string {
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function insertDocByPath(nodes: DocsNavNode[], doc: Doc): void {
  const relative = doc.sourcePath.replace(/^public-docs\//, "");
  const segments = relative.replace(/\.md$/, "").split("/");
  const fileName = segments.pop() ?? "";
  const directories = segments;

  let current = nodes;
  for (const segment of directories) {
    let group = current.find(
      (node): node is Extract<DocsNavNode, { type: "group" }> =>
        node.type === "group" && node.segment === segment,
    );

    if (!group) {
      group = {
        type: "group",
        segment,
        label: formatLabel(segment),
        children: [],
        order: doc.frontmatter.order,
      };
      current.push(group);
    }

    current = group.children;
  }

  const pageSegment = fileName === "index" ? (directories.at(-1) ?? "") : fileName;
  current.push({
    type: "page",
    segment: pageSegment,
    label: doc.frontmatter.nav,
    href: doc.href,
    order: doc.frontmatter.order,
  });
}

function nodeOrder(node: DocsNavNode): number {
  if (node.type === "page") return node.order;
  if (node.children.length === 0) return Infinity;
  let min = Infinity;
  for (const child of node.children) {
    const childOrder = nodeOrder(child);
    if (childOrder < min) min = childOrder;
  }
  return min;
}

function sortNodes(nodes: DocsNavNode[]): void {
  nodes.sort((a, b) => nodeOrder(a) - nodeOrder(b));
  for (const node of nodes) {
    if (node.type !== "page") {
      sortNodes(node.children);
    }
  }
}

export function buildDocsNavTree(docs: Doc[]): DocsNavNode[] {
  const byCategory = new Map<string, Doc[]>();
  const uncategorized: Doc[] = [];

  for (const doc of docs) {
    const category = doc.frontmatter.category?.trim();
    if (category) {
      const list = byCategory.get(category) ?? [];
      list.push(doc);
      byCategory.set(category, list);
    } else {
      uncategorized.push(doc);
    }
  }

  const root: DocsNavNode[] = [];

  for (const doc of uncategorized) {
    insertDocByPath(root, doc);
  }

  for (const [label, docsInCategory] of byCategory) {
    const children: DocsNavNode[] = [];
    for (const doc of docsInCategory) {
      insertDocByPath(children, doc);
    }
    root.push({
      type: "category",
      label,
      children,
      order: nodeOrder({ type: "category", label, children, order: Infinity }),
    });
  }

  sortNodes(root);
  return root;
}

function findNodePath(
  nodes: DocsNavNode[],
  href: string,
  path: DocsNavNode[] = [],
): DocsNavNode[] | null {
  for (const node of nodes) {
    if (node.type === "page" && node.href === href) {
      return [...path, node];
    }
    if (node.type !== "page") {
      const found = findNodePath(node.children, href, [...path, node]);
      if (found) return found;
    }
  }
  return null;
}

export function getDocBreadcrumbGroups(doc: Doc, tree: DocsNavNode[]): { label: string }[] {
  const path = findNodePath(tree, doc.href);
  if (!path) return [];

  return path
    .slice(0, -1)
    .filter((node): node is Extract<DocsNavNode, { type: "group" }> => node.type === "group")
    .map((node) => ({ label: node.label }));
}
