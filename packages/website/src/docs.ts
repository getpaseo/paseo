import Slugger from "github-slugger";
import { DEFAULT_LOCALE, type Locale, splitLocalePath, withLocalePrefix } from "~/i18n";
import { splitAnchorId } from "~/docs-anchor-ids";
import { groupTranslations, inLocale, parseFrontmatter } from "~/markdown-content";

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
  /** The language-neutral page path; localize it for the reader's language. */
  href: string;
  /** The file this doc's content comes from, such as `public-docs/cli.zh-CN.md`. */
  sourcePath: string;
  /** The language `content` is written in; English when the requested language has no translation. */
  locale: Locale;
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
      /** Set when the directory has an `index.md`, which makes the group landable. */
      href?: string;
    }
  | {
      type: "page";
      segment: string;
      label: string;
      href: string;
      order: number;
    };

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

export function parseHeadings(content: string): DocHeading[] {
  const slugger = new Slugger();
  const headings: DocHeading[] = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const depth = match[1].length;
    if (depth < 2 || depth > 4) continue;

    const heading = splitAnchorId(match[2].trim());
    const text = stripInlineMarkdown(heading.text);
    if (!text) continue;

    headings.push({
      depth,
      text,
      id: heading.id ?? slugger.slug(text),
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
  return `public-docs/${path.split("/public-docs/")[1] ?? path}`;
}

const docTranslations = groupTranslations(docModules);

function loadDocs(locale: Locale): Doc[] {
  const docs: Doc[] = [];

  for (const group of docTranslations) {
    const { raw, locale: contentLocale } = inLocale(group, locale);
    const { data, content } = parseFrontmatter(raw);
    // Where a doc sits in the navigation is the English original's decision in every language.
    const structure = parseFrontmatter(group.sources.en).data;
    const slug = pathToSlug(group.path);
    const href = slug === "" ? "/docs" : `/docs/${slug}`;
    const order = Number.parseInt(structure.order ?? "999", 10);
    const sourcePath = pathToSourcePath(group.path);

    docs.push({
      slug,
      href,
      sourcePath:
        contentLocale === DEFAULT_LOCALE
          ? sourcePath
          : sourcePath.replace(/\.md$/, `.${contentLocale}.md`),
      locale: contentLocale,
      frontmatter: {
        title: data.title ?? "",
        description: data.description ?? "",
        nav: data.nav ?? data.title ?? slug,
        order: Number.isFinite(order) ? order : 999,
        category: structure.category,
      },
      content,
      headings: parseHeadings(content),
    });
  }

  docs.sort((a, b) => a.frontmatter.order - b.frontmatter.order);
  return docs;
}

const cached = new Map<Locale, Doc[]>();

/** Every doc in a language, each in English where it has no translation yet. */
export function getDocs(locale: Locale): Doc[] {
  let docs = cached.get(locale);
  if (!docs) {
    docs = loadDocs(locale);
    cached.set(locale, docs);
  }
  return docs;
}

export function getDoc(slug: string, locale: Locale): Doc | undefined {
  return getDocs(locale).find((d) => d.slug === slug);
}

export function getLegacyDocsRedirect(pathname: string): string | undefined {
  const match =
    /^\/docs\/plugins\/v0\.[78](?:(\.md)|\/(index|reference|providers|migration)(\.md)?)?\/?$/.exec(
      pathname,
    );
  if (!match) return undefined;
  const page = match[2] && match[2] !== "index" ? `/${match[2]}` : "";
  const extension = match[1] || match[3] ? ".md" : "";
  return `/docs/plugins${page}${extension}`;
}

function formatLabel(segment: string): string {
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function insertDocByPath(nodes: DocsNavNode[], doc: Doc, stripTopDirectory = false): void {
  const relative = doc.sourcePath
    .replace(/^public-docs\//, "")
    .replace(doc.locale === DEFAULT_LOCALE ? ".md" : `.${doc.locale}.md`, "");
  const segments = relative.split("/");
  const fileName = segments.pop() ?? "";
  const directories = segments;

  // A section's top-level directory and its category name the same thing, so
  // only directories below it become collapsible groups.
  if (stripTopDirectory) directories.shift();

  let current = nodes;
  let parent: Extract<DocsNavNode, { type: "group" }> | undefined;
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

    parent = group;
    current = group.children;
  }

  // A directory's index.md describes its own group: it supplies the label and
  // order the directory name can't, and makes the group itself navigable.
  if (fileName === "index" && parent !== undefined) {
    parent.label = doc.frontmatter.nav;
    parent.order = doc.frontmatter.order;
    parent.href = doc.href;
    return;
  }

  current.push({
    type: "page",
    segment: fileName,
    label: doc.frontmatter.nav,
    href: doc.href,
    order: doc.frontmatter.order,
  });
}

function nodeOrder(node: DocsNavNode): number {
  if (node.type === "page") return node.order;
  if (node.type === "group" && node.href !== undefined) return node.order;
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
      insertDocByPath(children, doc, true);
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
      if (node.type === "group" && node.href === href) {
        return [...path, node];
      }
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

/** The raw Markdown URL of a doc, in the language its content is written in. */
export function docMarkdownPath(doc: Doc): string {
  return withLocalePrefix(doc.slug === "" ? "/docs.md" : `/docs/${doc.slug}.md`, doc.locale);
}

/**
 * Resolves a raw Markdown URL such as `/docs/cli.md` or `/zh-CN/docs/cli.md`. Returns null when the
 * URL is not a docs Markdown URL, and `{ doc: undefined }` when it names no doc.
 */
export function resolveDocMarkdownPath(pathname: string): { doc: Doc | undefined } | null {
  const { locale, path } = splitLocalePath(pathname);
  if (path === "/docs.md") return { doc: getDoc("", locale) };
  const match = /^\/docs\/(.+)\.md$/.exec(path);
  return match ? { doc: getDoc(match[1], locale) } : null;
}
