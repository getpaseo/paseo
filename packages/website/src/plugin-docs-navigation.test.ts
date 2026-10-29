import { describe, expect, it } from "vitest";
import { buildDocsNavTree, getDoc, getDocs, getLegacyDocsRedirect, parseHeadings } from "./docs";

describe("plugin documentation", () => {
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
