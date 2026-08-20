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
import { defineRpc } from "${sdk}/server";
import { z } from "zod";

const ping = defineRpc({
  name: "ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export default function contribute(plugin: PluginContext) {
  plugin.handle(ping, async () => ({ ok: true }));
  return () => undefined;
}
`,
      );

      const { clientBundle, serverBundle } = await compilePlugin(entryPath);
      expect(clientBundle).toContain(`${sdk}/server`);
      expect(serverBundle).toContain(`${sdk}/server`);
      expect(clientBundle).not.toContain("Invalid plugin RPC method");
      expect(serverBundle).not.toContain("Invalid plugin RPC method");
    },
  );
});
