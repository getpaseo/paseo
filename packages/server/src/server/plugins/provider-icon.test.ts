import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readPluginProviderIcon } from "./provider-icon.js";

const directories: string[] = [];

async function writeIcon(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-icon-"));
  directories.push(directory);
  await writeFile(path.join(directory, "icon.svg"), contents);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readPluginProviderIcon", () => {
  test("accepts a self-contained SVG", async () => {
    const svg =
      '<svg viewBox="0 0 24 24"><defs><path id="mark" d="M0 0h1v1z" /></defs><use href="#mark" /></svg>';
    const directory = await writeIcon(svg);

    await expect(readPluginProviderIcon(directory, "icon.svg")).resolves.toBe(svg);
  });

  test.each([
    ["non-SVG document", "hello", "file is not an SVG document"],
    ["script", "<svg><script /></svg>", "script elements"],
    ["foreign object", "<svg><foreignObject /></svg>", "foreignObject elements"],
    ["style", "<svg><style /></svg>", "style elements"],
    ["event handler", '<svg><path onclick="run()" /></svg>', "event-handler attributes"],
    ["javascript URL", '<svg><a href="javascript:run()" /></svg>', "javascript URLs"],
    ["external href", '<svg><use href="https://example.com/icon.svg" /></svg>', "external href"],
  ])("rejects %s", async (_name, svg, reason) => {
    const directory = await writeIcon(svg);

    await expect(readPluginProviderIcon(directory, "icon.svg")).rejects.toThrow(
      `icon.svg": ${reason}`,
    );
  });

  test("rejects a path outside the plugin directory", async () => {
    const directory = await writeIcon("<svg />");

    await expect(readPluginProviderIcon(directory, "../icon.svg")).rejects.toThrow(
      "path leaves the plugin directory",
    );
  });

  test("rejects a symlink that escapes the plugin directory", async () => {
    const directory = await writeIcon("<svg />");
    const externalDirectory = await mkdtemp(path.join(tmpdir(), "paseo-external-icon-"));
    directories.push(externalDirectory);
    const externalIcon = path.join(externalDirectory, "external.svg");
    await writeFile(externalIcon, "<svg />");
    await symlink(externalIcon, path.join(directory, "linked.svg"));

    await expect(readPluginProviderIcon(directory, "linked.svg")).rejects.toThrow(
      "path leaves the plugin directory",
    );
  });

  test("rejects a directory instead of a regular file", async () => {
    const directory = await writeIcon("<svg />");
    await mkdir(path.join(directory, "nested.svg"));

    await expect(readPluginProviderIcon(directory, "nested.svg")).rejects.toThrow(
      "file does not exist or is not a regular file",
    );
  });

  test("rejects an icon larger than 64 KiB", async () => {
    const directory = await writeIcon(`<svg>${" ".repeat(64 * 1024)}</svg>`);

    await expect(readPluginProviderIcon(directory, "icon.svg")).rejects.toThrow(
      "file exceeds 64 KiB",
    );
  });
});
