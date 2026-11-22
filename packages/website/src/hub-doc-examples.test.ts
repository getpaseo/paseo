import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { getDoc, getDocs, getLegacyDocsRedirect, parseHeadings } from "./docs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const hubDocs = path.join(repositoryRoot, "public-docs", "hub");

describe("Hub public documentation examples", () => {
  it("parses every Hub YAML example and keeps trigger documents canonical", async () => {
    const files = [
      ...(await markdownFiles(hubDocs)),
      path.join(repositoryRoot, "public-docs", "cli.md"),
    ];
    let exampleCount = 0;
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      for (const [index, source] of yamlFences(markdown).entries()) {
        exampleCount += 1;
        const label = `${path.relative(repositoryRoot, file)} YAML example ${index + 1}`;
        const parsed = YAML.parse(source);
        expect(parsed, label).not.toBeUndefined();
        if (!isRecord(parsed)) continue;
        expect(parsed, `${label} must not teach monolithic triggers`).not.toHaveProperty(
          "triggers",
        );
        expect(parsed, `${label} must not teach legacy stepped workflows`).not.toHaveProperty(
          "steps",
        );
        if (Object.hasOwn(parsed, "environments")) {
          expect(isRecord(parsed["environments"]), `${label} environments`).toBe(true);
        }
        if (Object.hasOwn(parsed, "agents")) {
          expect(isRecord(parsed["agents"]), `${label} agents`).toBe(true);
        }
      }
    }
    expect(exampleCount).toBeGreaterThan(20);
  });

  it("does not teach removed Hub authoring paths or legacy stepped workflows", async () => {
    const markdown = (
      await Promise.all((await markdownFiles(hubDocs)).map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(markdown).not.toContain(".paseo/partials/");
    expect(markdown).not.toContain(".paseo/workflows/");
    expect(markdown).not.toContain(".paseo/hub.yml");
    expect(markdown).not.toMatch(/^triggers:/mu);
    expect(markdown).not.toMatch(/^steps:/mu);
    expect(markdown).not.toMatch(/^\s+allow_outputs:/mu);
    expect(markdown).not.toMatch(/^\s+uses:/mu);
    expect(markdown).not.toContain("paseo hub deploy [file]");
  });

  it.each(["en", "zh-CN"] as const)(
    "resolves every internal /docs/hub link and heading anchor in %s",
    (locale) => {
      const docs = getDocs(locale);
      const headingsByHref = new Map(docs.map((doc) => [doc.href, headingIds(doc.content)]));
      const hubPages = docs.filter(
        (doc) => doc.href === "/docs/hub" || doc.href.startsWith("/docs/hub/"),
      );
      expect(hubPages.length).toBeGreaterThanOrEqual(25);

      const broken: string[] = [];
      for (const doc of hubPages) {
        for (const match of doc.content.matchAll(/\]\((\/docs\/hub[^)\s]*)\)/gu)) {
          const target = match[1] ?? "";
          const [rawPath, hash] = target.split("#");
          const cleanPath = (rawPath ?? "").replace(/\/$/u, "");
          const headings = headingsByHref.get(cleanPath);
          if (!headings) {
            broken.push(`${doc.sourcePath} -> missing page ${target}`);
          } else if (hash && !headings.has(hash)) {
            broken.push(`${doc.sourcePath} -> missing anchor ${target}`);
          }
        }
      }
      expect(broken).toEqual([]);
    },
  );

  it("redirects removed legacy Hub workflow and hub-yml paths to current pages", () => {
    const redirects = [
      ["/docs/hub/workflows", "/docs/hub/triggers"],
      ["/docs/hub/configuration/hub-yml", "/docs/hub/configuration/reference"],
    ] as const;

    for (const [legacyPath, targetPath] of redirects) {
      expect(getDoc(targetPath.slice("/docs/".length), "en")).toBeDefined();
      expect(getDoc(targetPath.slice("/docs/".length), "zh-CN")).toBeDefined();
      for (const extension of ["", ".md"]) {
        expect(getLegacyDocsRedirect(`${legacyPath}${extension}`)).toBe(
          `${targetPath}${extension}`,
        );
        expect(getLegacyDocsRedirect(`${legacyPath}${extension}/`)).toBe(
          `${targetPath}${extension}`,
        );
        expect(getLegacyDocsRedirect(`${targetPath}${extension}`)).toBeUndefined();
      }
    }
  });
});

function headingIds(content: string): Set<string> {
  return new Set(parseHeadings(content).map((heading) => heading.id));
}

function yamlFences(markdown: string): readonly string[] {
  return [...markdown.matchAll(/```yaml\s*\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
