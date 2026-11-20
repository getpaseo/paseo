import { describe, expect, it } from "vitest";
import { groupTranslations, inLocale } from "~/markdown-content";

describe("groupTranslations", () => {
  it("files each translation under its English original", () => {
    const [cli, why] = groupTranslations({
      "docs/cli.md": "CLI",
      "docs/cli.zh-CN.md": "命令行",
      "docs/why.md": "Why",
    });

    expect(cli).toEqual({ path: "docs/cli.md", sources: { en: "CLI", "zh-CN": "命令行" } });
    expect(inLocale(cli, "zh-CN")).toEqual({ raw: "命令行", locale: "zh-CN" });
    expect(inLocale(why, "zh-CN")).toEqual({ raw: "Why", locale: "en" });
  });

  it("refuses a translation without an English original", () => {
    expect(() => groupTranslations({ "docs/gone.zh-CN.md": "已删除" })).toThrow(
      "docs/gone.md has a translation but no English original",
    );
  });

  it("treats a dotted name that is not a site language as English", () => {
    const groups = groupTranslations({ "posts/v0.1.md": "v0.1", "posts/notes.fr.md": "Notes" });

    expect(groups.map((group) => group.path)).toEqual(["posts/v0.1.md", "posts/notes.fr.md"]);
  });
});
