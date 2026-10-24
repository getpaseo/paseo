import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localFileSourceToPath } from "@/attachments/utils";
import { createAssistantMarkdownParser } from "./assistant-markdown-parser";
import { resolveAssistantImageSource } from "./assistant-image-source";

describe("local assistant Markdown images", () => {
  let workspaceRoot: string;
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-markdown-image-"));
    await mkdir(path.join(workspaceRoot, "My Apps", "Мои"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "My Apps", "Мои", "test.png"), imageBytes);
    await writeFile(path.join(workspaceRoot, "literal%20name.png"), imageBytes);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each([
    "absolute angle",
    "absolute encoded",
    "relative angle",
    "relative encoded",
    "file URI",
    "literal percent",
  ])("reads the actual image for the %s destination", async (form) => {
    const absolute = path.join(workspaceRoot, "My Apps", "Мои", "test.png");
    const destinations: Record<string, string> = {
      "absolute angle": `<${absolute}>`,
      "absolute encoded": encodeURI(absolute),
      "relative angle": "<My Apps/Мои/test.png>",
      "relative encoded": encodeURI("My Apps/Мои/test.png"),
      "file URI": `file://${encodeURI(absolute)}`,
      "literal percent": `${workspaceRoot}/literal%2520name.png`,
    };
    const tokens = createAssistantMarkdownParser().parseInline(
      `![test](${destinations[form]})`,
      {},
    );
    const image = tokens
      .flatMap((token) => token.children ?? [])
      .find((token) => token.type === "image");
    expect(image).toBeDefined();
    const source = localFileSourceToPath(image!.attrGet("src")!, { decodeHref: true });
    const target = resolveAssistantImageSource({ source, workspaceRoot });
    expect(target?.kind).toBe("file_rpc");
    if (target?.kind !== "file_rpc") throw new Error("Expected a local image read target");
    await expect(readFile(path.resolve(target.cwd, target.path))).resolves.toEqual(imageBytes);
  });
});
