import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.tsx"), source, "utf8");
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it("loads the official Linear attachment extension", async () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../extensions/linear",
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.start({ linear: { source: "directory", path: directory } });

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stop();
  });

  it("loads one index.tsx, exposes its client bundle, and invokes its server RPC", async () => {
    const directory = await createPlugin(
      "hello",
      `import React from "react";
import { platform } from "node:os";
import { Text } from "react-native";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "@paseo/plugin";

const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string(), platform: z.string() }),
});

const attachments = defineAttachmentSource({
  id: "issues",
  title: "Example issue",
  icon: "CircleDot",
  pickerTitle: "Attach example issue",
  searchPlaceholder: "Search issues",
  search: greetRpc,
});

function HelloSurface() {
  return <Text>Hello from native UI</Text>;
}

export default function contribute(plugin: any) {
  plugin.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  plugin.addSurface("main", HelloSurface);
  plugin.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  plugin.addAttachmentSource(attachments);
}`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.start({ hello: { source: "directory", path: directory } });

    const catalog = runtime.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("hello");
    expect(catalog[0]?.clientBundle).toContain("Hello from native UI");
    expect(catalog[0]?.clientBundle).toContain("Attach example issue");
    expect(catalog[0]?.clientBundle).not.toContain("node:os");
    expect(catalog[0]?.clientBundle).not.toContain("get: () => from[key]");
    await expect(runtime.invoke("hello", "greet", { name: "Paseo" })).resolves.toMatchObject({
      message: "Hello, Paseo",
    });
    await expect(runtime.invoke("hello", "greet", { name: 7 })).rejects.toThrow();

    await runtime.stop();
  });

  it("rejects a handler result that does not match its RPC output schema", async () => {
    const directory = await createPlugin(
      "invalid-output",
      `import { z } from "zod";
import { defineRpc } from "@paseo/plugin";
const brokenRpc = defineRpc({
  name: "broken",
  input: z.object({}),
  output: z.object({ value: z.number() }),
});
export default function contribute(plugin: any) {
  plugin.handle(brokenRpc, async () => ({ value: "wrong" }));
}`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.start({ "invalid-output": { source: "directory", path: directory } });

    await expect(runtime.invoke("invalid-output", "broken", {})).rejects.toThrow();
    await runtime.stop();
  });

  it("rejects a configured id that does not match the manifest", async () => {
    const directory = await createPlugin("actual", `export default function contribute() {}`);
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.start({ configured: { source: "directory", path: directory } });

    expect(runtime.catalog()).toEqual([]);
    await runtime.stop();
  });
});
