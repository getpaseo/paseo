import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const hubDocs = path.join(repositoryRoot, "public-docs", "hub");

describe("Hub public documentation examples", () => {
  it("parses every Hub YAML example and keeps resource maps canonical", async () => {
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

  it("does not teach removed Hub authoring paths or composition fields", async () => {
    const markdown = (
      await Promise.all((await markdownFiles(hubDocs)).map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(markdown).not.toContain(".paseo/partials/");
    expect(markdown).not.toMatch(/^triggers:/mu);
    expect(markdown).not.toMatch(/^\s+uses:/mu);
    expect(markdown).not.toContain("paseo hub deploy [file]");
  });
});

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
