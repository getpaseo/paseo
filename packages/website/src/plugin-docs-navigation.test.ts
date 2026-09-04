import { describe, expect, it } from "vitest";
import { buildDocsNavTree, getDocs, getLegacyDocsRedirect } from "./docs";

describe("versioned plugin documentation", () => {
  it("keeps current and preview releases together in the Plugins navigation", () => {
    const plugins = buildDocsNavTree(getDocs()).find(
      (node) => node.type === "category" && node.label === "Plugins",
    );

    expect(plugins).toMatchObject({
      type: "category",
      children: [
        { type: "page", label: "Versions", href: "/docs/plugins" },
        {
          type: "group",
          label: "Paseo v0.7 — Current",
          href: "/docs/plugins/v0.7",
          children: [{ type: "page", label: "Reference", href: "/docs/plugins/v0.7/reference" }],
        },
        {
          type: "group",
          label: "Paseo v0.8 — Preview",
          href: "/docs/plugins/v0.8",
          children: [
            { type: "page", label: "Reference", href: "/docs/plugins/v0.8/reference" },
            { type: "page", label: "Migration", href: "/docs/plugins/v0.8/migration" },
          ],
        },
      ],
    });
  });

  it("keeps existing plugin documentation URLs working", () => {
    expect(getLegacyDocsRedirect("/docs/plugins/reference")).toBe("/docs/plugins/v0.7/reference");
    expect(getLegacyDocsRedirect("/docs/plugins/reference.md")).toBe(
      "/docs/plugins/v0.7/reference.md",
    );
    expect(getLegacyDocsRedirect("/docs/plugins/migration")).toBe("/docs/plugins/v0.8/migration");
    expect(getLegacyDocsRedirect("/docs/plugins/migration.md")).toBe(
      "/docs/plugins/v0.8/migration.md",
    );
  });
});
