import { describe, expect, it } from "vitest";
import { pageMeta } from "~/meta";
import en from "./resources/en.json";
import zhCN from "./resources/zh-CN.json";
import { localeFromParam, localizePath, splitLocalePath } from "./locale";

describe("locale paths", () => {
  it("move a page between languages and keep its query and hash", () => {
    expect(splitLocalePath("/zh-CN/plugins/all?q=dark#top")).toEqual({
      locale: "zh-CN",
      path: "/plugins/all?q=dark#top",
    });
    expect(splitLocalePath("/zh-CN")).toEqual({ locale: "zh-CN", path: "/" });
    expect(splitLocalePath("/zh-CNx")).toEqual({ locale: "en", path: "/zh-CNx" });
    expect(localizePath("/zh-CN/docs/cli?x=1", "en")).toBe("/docs/cli?x=1");
    expect(localizePath("/docs/cli#agent-run", "zh-CN")).toBe("/zh-CN/docs/cli#agent-run");
    expect(localizePath("/", "zh-CN")).toBe("/zh-CN");
  });

  it("leave files, endpoints, and external links alone", () => {
    for (const path of ["/docs/cli.md", "/llms.txt", "/api/download", "https://x.dev/a", "#top"]) {
      expect(localizePath(path, "zh-CN")).toBe(path);
    }
  });

  it("never spell English in a URL", () => {
    expect(localeFromParam(undefined)).toBe("en");
    expect(localeFromParam("zh-CN")).toBe("zh-CN");
    expect(localeFromParam("en")).toBeNull();
    expect(localeFromParam("fr")).toBeNull();
  });
});

describe("pageMeta", () => {
  it("is canonical to itself and lists every language with English as x-default", () => {
    const { meta, links } = pageMeta({
      title: "命令行",
      description: "说明",
      path: "/docs/cli",
      locale: "zh-CN",
    });

    expect(links).toEqual([
      { rel: "canonical", href: "https://paseo.sh/zh-CN/docs/cli" },
      { rel: "alternate", hrefLang: "en", href: "https://paseo.sh/docs/cli" },
      { rel: "alternate", hrefLang: "zh-CN", href: "https://paseo.sh/zh-CN/docs/cli" },
      { rel: "alternate", hrefLang: "x-default", href: "https://paseo.sh/docs/cli" },
    ]);
    expect(meta).toEqual(
      expect.arrayContaining([
        { property: "og:locale", content: "zh_CN" },
        { property: "og:locale:alternate", content: "en_US" },
        { property: "og:url", content: "https://paseo.sh/zh-CN/docs/cli" },
        { name: "twitter:title", content: "命令行" },
      ]),
    );
  });
});

interface Resources {
  [key: string]: string | Resources;
}

/** Every string in a resource tree, keyed by its dotted path. */
function strings(resources: Resources, prefix = ""): [string, string][] {
  return Object.entries(resources).flatMap(([key, value]): [string, string][] =>
    typeof value === "string" ? [[`${prefix}${key}`, value]] : strings(value, `${prefix}${key}.`),
  );
}

function placeholders(text: string): string {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join();
}

describe("interface copy", () => {
  it("fills the same placeholders in every language", () => {
    const chinese = new Map(strings(zhCN));
    const mismatched = strings(en).filter(([key, english]) => {
      const translated = chinese.get(key);
      return translated !== undefined && placeholders(translated) !== placeholders(english);
    });

    expect(mismatched).toEqual([]);
  });
});
