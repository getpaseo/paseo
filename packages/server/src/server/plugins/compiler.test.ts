import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compilePlugin,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler.js";

const asarEsbuildDir = path.join("Resources", "app.asar", "node_modules", "esbuild");

describe("asar esbuild binary resolution", () => {
  it("rewrites an asar package path to the unpacked platform binary", () => {
    expect(unpackedEsbuildBinaryFromPackageDir(asarEsbuildDir, "darwin", "arm64")).toBe(
      path.join(
        "Resources",
        "app.asar.unpacked",
        "node_modules",
        "@esbuild",
        "darwin-arm64",
        "bin",
        "esbuild",
      ),
    );
    expect(unpackedEsbuildBinaryFromPackageDir(asarEsbuildDir, "win32", "x64")).toBe(
      path.join(
        "Resources",
        "app.asar.unpacked",
        "node_modules",
        "@esbuild",
        "win32-x64",
        "esbuild.exe",
      ),
    );
  });

  it("ignores package paths that are not inside app.asar", () => {
    expect(
      unpackedEsbuildBinaryFromPackageDir(path.join("node_modules", "esbuild"), "darwin", "arm64"),
    ).toBeNull();
  });

  it("returns null when the unpacked binary is missing", () => {
    expect(
      resolveExistingAsarUnpackedEsbuildBinary(asarEsbuildDir, "darwin", "arm64", () => false),
    ).toBeNull();
  });

  it("returns the unpacked path when the binary exists", () => {
    expect(
      resolveExistingAsarUnpackedEsbuildBinary(asarEsbuildDir, "linux", "x64", () => true),
    ).toBe(
      path.join(
        "Resources",
        "app.asar.unpacked",
        "node_modules",
        "@esbuild",
        "linux-x64",
        "bin",
        "esbuild",
      ),
    );
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("plugin author module externals", () => {
  // COMPAT(plugin-sdk-scope): plugins written against the unpublished @paseo/plugin name must
  // keep compiling. Drop that case with the specifiers in plugin-sdk-specifiers.ts.
  it.each(["@getpaseo/plugin", "@paseo/plugin"])(
    "leaves %s/server external in both bundles",
    async (sdk) => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
      temporaryDirectories.push(directory);
      const entryPath = path.join(directory, "index.ts");
      await writeFile(
        entryPath,
        `import type { PluginContext } from "${sdk}";
import { Icon } from "${sdk}/react-native";
import { defineRpc } from "${sdk}/server";
import { z } from "zod";

const ping = defineRpc({
  name: "ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

function Surface() {
  return Icon({ name: "Settings", size: 18 });
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(ping, async () => ({ ok: true }));
  plugin.addSurface("main", Surface);
  return () => undefined;
}
`,
      );

      const { clientBundle, serverBundle } = await compilePlugin(entryPath);
      expect(clientBundle).toContain(`${sdk}/react-native`);
      expect(clientBundle).toContain(`${sdk}/server`);
      expect(serverBundle).toContain(`${sdk}/server`);
      expect(serverBundle).not.toContain(`${sdk}/react-native`);
      expect(clientBundle).toContain("Settings");
      expect(serverBundle).not.toContain("Settings");
      expect(clientBundle).not.toContain("Invalid plugin RPC method");
      expect(serverBundle).not.toContain("Invalid plugin RPC method");
    },
  );
});

describe("plugin contribution targets", () => {
  it("keeps client contributions out of the server bundle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  plugin.addTimelineTransformer({
    id: "timeline-card",
    query: { itemType: "tool_call" },
    transform() { return { items: [] }; },
  });
  plugin.addTimelineRenderer({
    kind: "timeline-card",
    version: 1,
    schema: { safeParse(value) { return { success: true, data: value }; } },
    Component() { return null; },
  });
  plugin.addClientSide((client) => {
    return client.addComposerPill({
      id: "composer-card",
      title: "Composer card",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      Component() { return null; },
      onPress() {},
    });
  });
  return () => undefined;
}
`,
    );

    const { clientBundle, serverBundle } = await compilePlugin(entryPath);
    expect(clientBundle).toContain("timeline-card");
    expect(clientBundle).toContain("composer-card");
    expect(serverBundle).not.toContain("timeline-card");
    expect(serverBundle).not.toContain("composer-card");
  });
});

describe("plugin client runtime syntax", () => {
  it("lowers async callbacks before Hermes evaluates the client bundle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.tsx");
    await writeFile(
      entryPath,
      `import type { PluginContext } from "@getpaseo/plugin";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("probe", () => {
    const refresh = async () => "ready";
    return refresh;
  });
  plugin.handle({ name: "probe" } as never, async () => "ready");
  return () => undefined;
}
`,
    );

    const { clientBundle, serverBundle } = await compilePlugin(entryPath);
    expect(clientBundle).not.toContain("async () =>");
    expect(clientBundle).toContain("__async");
    expect(serverBundle).toContain("async () =>");
  });
});
