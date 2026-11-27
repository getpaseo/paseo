import { describe, expect, it } from "vitest";
import { buildDocsNavTree, getDoc, getDocs, getLegacyDocsRedirect, parseHeadings } from "./docs";
import { buildLlmsTxt } from "./llms";

describe("docs frontmatter", () => {
  it.each(["en", "zh-CN"] as const)("gives every %s page a title and a description", (locale) => {
    const incomplete = getDocs(locale)
      .filter((doc) => !doc.frontmatter.title || !doc.frontmatter.description)
      .map((doc) => doc.sourcePath);
    expect(incomplete).toEqual([]);
  });

  it("puts every page in a sidebar category", () => {
    const uncategorized = getDocs("en")
      .filter((doc) => !doc.frontmatter.category)
      .map((doc) => doc.sourcePath);
    expect(uncategorized).toEqual([]);
  });
});

describe("provider documentation", () => {
  it.each(["en", "zh-CN"] as const)(
    "nests each provider page under Supported providers in %s",
    (locale) => {
      const providers = buildDocsNavTree(getDocs(locale)).find(
        (node) => node.type === "category" && node.label === "Providers",
      );
      expect(providers).toMatchObject({
        children: [
          { type: "page", href: "/docs/providers" },
          {
            type: "group",
            href: "/docs/supported-providers",
            children: [
              { href: "/docs/supported-providers/antigravity" },
              { href: "/docs/supported-providers/claude-code" },
              { href: "/docs/supported-providers/codex" },
              { href: "/docs/supported-providers/fx" },
              { href: "/docs/supported-providers/github-copilot" },
              { href: "/docs/supported-providers/hoplite" },
              { href: "/docs/supported-providers/muse-code" },
              { href: "/docs/supported-providers/omp" },
              { href: "/docs/supported-providers/opencode" },
              { href: "/docs/supported-providers/pi" },
            ],
          },
          { type: "page", href: "/docs/custom-providers" },
        ],
      });
    },
  );

  it.each([
    ["en", "https://paseo.sh/docs"],
    ["zh-CN", "https://paseo.sh/zh-CN/docs"],
  ] as const)(
    "lists each provider page in the %s llms.txt, in sidebar order",
    (locale, docsUrl) => {
      const llms = buildLlmsTxt(locale);
      const positions = [
        "supported-providers.md",
        "supported-providers/antigravity.md",
        "supported-providers/codex.md",
        "supported-providers/pi.md",
        "custom-providers.md",
      ].map((page) => llms.indexOf(`(${docsUrl}/${page})`));

      expect(positions).not.toContain(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    },
  );

  it.each(["claude-code", "codex", "muse-code"])(
    "redirects the old top-level %s link to the page under Supported providers",
    (slug) => {
      const target = `/docs/supported-providers/${slug}`;
      expect(getDoc(target.slice("/docs/".length), "en")).toBeDefined();
      for (const extension of ["", ".md"]) {
        expect(getLegacyDocsRedirect(`/docs/${slug}${extension}`)).toBe(`${target}${extension}`);
        expect(getLegacyDocsRedirect(`/docs/${slug}${extension}/`)).toBe(`${target}${extension}`);
        expect(getLegacyDocsRedirect(`${target}${extension}`)).toBeUndefined();
      }
    },
  );
});

describe("plugin documentation", () => {
  it.each(["en", "zh-CN"] as const)(
    "nests local file copying under Git worktrees in %s",
    (locale) => {
      const workspaces = buildDocsNavTree(getDocs(locale)).find(
        (node) => node.type === "category" && node.label === "Workspaces",
      );
      expect(workspaces).toMatchObject({
        children: expect.arrayContaining([
          expect.objectContaining({
            type: "group",
            href: "/docs/worktrees",
            children: [expect.objectContaining({ href: "/docs/worktrees/worktreeinclude" })],
          }),
        ]),
      });
      expect(getDoc("worktrees/worktreeinclude", locale)).toBeDefined();
    },
  );

  it("groups current guides by task without version navigation", () => {
    const plugins = buildDocsNavTree(getDocs("en")).find(
      (node) => node.type === "category" && node.label === "Plugins",
    );

    expect(plugins).toMatchObject({
      type: "category",
      children: [
        { type: "page", label: "Quickstart", href: "/docs/plugins" },
        { type: "page", label: "Publishing", href: "/docs/plugins/publishing" },
        { type: "page", label: "Provider plugins", href: "/docs/plugins/providers" },
        { type: "page", label: "Sidebar views", href: "/docs/plugins/sidebar-views" },
        { type: "page", label: "Migration", href: "/docs/plugins/migration" },
        { type: "page", label: "Hooks", href: "/docs/plugins/hooks" },
        { type: "page", label: "Reference", href: "/docs/plugins/reference" },
      ],
    });
  });

  it.each(["en", "zh-CN"] as const)("resolves worktree placement hook links in %s", (locale) => {
    const hooks = getDoc("plugins/hooks", locale)!;
    expect(parseHeadings(hooks.content).map((heading) => heading.id)).toContain(
      "worktreecreatebefore",
    );
    expect(hooks.content).toContain("plugin-examples/worktree-placement");
  });

  it.each(["v0.7", "v0.8"])("redirects %s links to existing current pages", (version) => {
    for (const page of ["", "/index", "/reference", "/providers", "/migration"]) {
      const target = `/docs/plugins${page === "/index" ? "" : page}`;
      expect(getDoc(target.slice("/docs/".length), "en")).toBeDefined();
      for (const extension of ["", ".md"]) {
        const source = `/docs/plugins/${version}${page}${extension}`;
        expect(getLegacyDocsRedirect(source)).toBe(`${target}${extension}`);
        expect(getLegacyDocsRedirect(`${source}/`)).toBe(`${target}${extension}`);
      }
    }
  });

  it("serves canonical pages without redirect loops", () => {
    for (const page of ["", "/publishing", "/reference", "/providers", "/migration", "/hooks"]) {
      expect(getLegacyDocsRedirect(`/docs/plugins${page}`)).toBeUndefined();
      expect(getLegacyDocsRedirect(`/docs/plugins${page}.md`)).toBeUndefined();
    }
    expect(getLegacyDocsRedirect("/docs/plugins/v0.8/unknown")).toBeUndefined();
  });
});
