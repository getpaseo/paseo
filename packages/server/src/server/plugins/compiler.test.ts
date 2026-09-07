import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compilePlugin,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler.js";

const asarEsbuildDir = path.join("Resources", "app.asar", "node_modules", "esbuild");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

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

async function createSplitPlugin(): Promise<{
  directory: string;
  client: string;
  server: string;
}> {
  // Keep the platform's original spelling (including Windows short names) in symlink
  // targets. Only diagnostic expectations use canonical paths.
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
  temporaryDirectories.push(directory);
  await Promise.all([
    mkdir(path.join(directory, "client")),
    mkdir(path.join(directory, "server")),
    mkdir(path.join(directory, "shared")),
  ]);
  const client = path.join(directory, "index.client.tsx");
  const server = path.join(directory, "index.server.ts");
  await Promise.all([
    writeFile(
      path.join(directory, "shared", "labels.ts"),
      `export const clientLabel = "Client contribution";
export const serverLabel = "Server contribution";`,
    ),
    writeFile(
      path.join(directory, "client", "surface.tsx"),
      `import { Text } from "react-native";
import { clientLabel } from "../shared/labels";
export function Surface() { return <Text>{clientLabel}</Text>; }`,
    ),
    writeFile(
      path.join(directory, "server", "handler.ts"),
      `import { serverLabel } from "../shared/labels";
export function handler() { return { label: serverLabel }; }`,
    ),
    writeFile(
      client,
      `import { Surface } from "./client/surface";
export default function contribute(client) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
    ),
    writeFile(
      server,
      `import { handler } from "./server/handler";
export default function contribute(server) {
  server.handle({ name: "probe" }, handler);
  return () => undefined;
}`,
    ),
  ]);
  return { directory, client, server };
}

async function createRootAlias(directory: string): Promise<string> {
  const aliases = await mkdtemp(path.join(tmpdir(), "paseo-plugin-root-alias-"));
  temporaryDirectories.push(aliases);
  const rootAlias = path.join(aliases, "plugin");
  await symlink(directory, rootAlias, process.platform === "win32" ? "junction" : "dir");
  return rootAlias;
}

describe("plugin runtime entries", () => {
  it.each([
    "react",
    "react/jsx-runtime",
    "react-native",
    "@getpaseo/plugin/client",
    "@getpaseo/plugin/client/ui",
  ])("rejects %s from server code", async (specifier) => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.server,
      `import * as value from "${specifier}"; export default function contribute() { return value; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow("client-only module");
  });

  it.each([
    "@getpaseo/plugin/server",
    "@getpaseo/plugin/server/provider",
    "@getpaseo/plugin/server/acp",
  ])("rejects %s from client code", async (specifier) => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.client,
      `import * as value from "${specifier}"; export default function contribute() { return value; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow("server-only module");
  });

  it.each([
    "react",
    "node:fs",
    "fs",
    "@getpaseo/plugin/client",
    "@getpaseo/plugin/server",
    "../client/surface",
    "../server/handler",
  ])("rejects %s from shared code", async (specifier) => {
    const entries = await createSplitPlugin();
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      `import * as value from "${specifier}"; export const clientLabel = value; export const serverLabel = value;`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
  });

  it.each([
    { target: "client", dependency: "react" },
    { target: "server", dependency: "node:fs" },
    { target: "server", dependency: "@getpaseo/plugin/server/provider" },
  ] as const)(
    "rejects a shared dependency reaching $dependency in the $target bundle",
    async ({ target, dependency }) => {
      const entries = await createSplitPlugin();
      const dependencyDirectory = path.join(entries.directory, "node_modules/impure");
      await mkdir(dependencyDirectory, { recursive: true });
      await writeFile(
        path.join(dependencyDirectory, "package.json"),
        JSON.stringify({ name: "impure", main: "index.js" }),
      );
      await writeFile(path.join(dependencyDirectory, "index.js"), `export * from "${dependency}";`);
      await writeFile(
        path.join(entries.directory, "shared/labels.ts"),
        `import * as value from "impure"; export const clientLabel = value; export const serverLabel = value;`,
      );
      await expect(
        compilePlugin({
          client: target === "client" ? entries.client : null,
          server: target === "server" ? entries.server : null,
        }),
      ).rejects.toThrow("plugin shared");
    },
  );

  it.each([
    'import type { PluginClientContext } from "@getpaseo/plugin/client"; export type Context = PluginClientContext;',
    'export type { PluginClientContext } from "@getpaseo/plugin/client";',
    'export type Context = import("@getpaseo/plugin/client").PluginClientContext;',
    'import { type PluginClientContext } from "@getpaseo/plugin/client"; export type Context = PluginClientContext;',
    'import type { ComponentType } from "react"; export type Component = ComponentType;',
  ])("rejects runtime-owned types in shared code: %s", async (typeSource) => {
    const entries = await createSplitPlugin();
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      typeSource + '\nexport const clientLabel = "client"; export const serverLabel = "server";',
    );
    await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
  });

  it.each([{ types: "./index.d.ts" }, { exports: { ".": { types: "./index.d.ts" } } }])(
    "accepts declaration-only dependencies: %j",
    async (manifest) => {
      const entries = await createSplitPlugin();
      const dependency = path.join(entries.directory, "node_modules/neutral-types");
      await mkdir(dependency, { recursive: true });
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "neutral-types", ...manifest }),
      );
      await writeFile(
        path.join(dependency, "index.d.ts"),
        "export type JsonValue = string | number | boolean | null;",
      );
      await writeFile(
        path.join(entries.directory, "shared/labels.ts"),
        'import type { JsonValue } from "neutral-types"; export const clientLabel: JsonValue = "client"; export const serverLabel: JsonValue = "server";',
      );
      const result = await compilePlugin(entries);
      expect(result.clientBundle).toContain('"client"');
      expect(result.serverBundle).toContain('"server"');
      expect(result.clientBundle).not.toContain("neutral-types");
    },
  );

  it("accepts a declaration import used only as a type without import type", async () => {
    const entries = await createSplitPlugin();
    const dependency = path.join(entries.directory, "node_modules/neutral-types");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "neutral-types", types: "./index.d.ts" }),
    );
    await writeFile(path.join(dependency, "index.d.ts"), "export type Value = string;");
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      'import { Value } from "neutral-types"; export const clientLabel: Value = "client"; export const serverLabel: Value = "server";',
    );
    await expect(compilePlugin(entries)).resolves.toMatchObject({
      clientBundle: expect.any(String),
      serverBundle: expect.any(String),
    });
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      'import { Value } from "neutral-types"; export const clientLabel = Value; export const serverLabel = Value;',
    );
    await expect(compilePlugin(entries)).rejects.toThrow('Could not resolve "neutral-types"');
  });

  it("preserves guarded optional requires in server dependencies", async () => {
    const entries = await createSplitPlugin();
    const dependency = path.join(entries.directory, "node_modules/optional-helper");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "optional-helper", main: "index.js" }),
    );
    await writeFile(
      path.join(dependency, "index.js"),
      'let value = "fallback"; try { value = require("missing-accelerator"); } catch {} module.exports = value;',
    );
    await writeFile(entries.server, 'import value from "optional-helper"; export default value;');
    await expect(compilePlugin({ client: null, server: entries.server })).resolves.toMatchObject({
      serverBundle: expect.stringContaining("fallback"),
    });
    await writeFile(
      path.join(dependency, "index.js"),
      'module.exports = require("missing-accelerator");',
    );
    await expect(compilePlugin({ client: null, server: entries.server })).rejects.toThrow(
      'Could not resolve "missing-accelerator"',
    );
  });

  it.each(["path", "types"])(
    "checks declaration reference %s directives",
    async (referenceKind) => {
      const entries = await createSplitPlugin();
      const dependency = path.join(entries.directory, "node_modules/typed-helper");
      const referencedDirectory =
        referenceKind === "path"
          ? dependency
          : path.join(entries.directory, "node_modules/@types/referenced-helper");
      await mkdir(dependency, { recursive: true });
      await mkdir(referencedDirectory, { recursive: true });
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "typed-helper", types: "index.d.ts" }),
      );
      await writeFile(
        path.join(dependency, "index.d.ts"),
        `/// <reference ${referenceKind}="${referenceKind === "path" ? "./context.d.ts" : "referenced-helper"}" />
export type Value = string;`,
      );
      const referencedFile = path.join(
        referencedDirectory,
        referenceKind === "path" ? "context.d.ts" : "index.d.ts",
      );
      await writeFile(
        referencedFile,
        'export type { PluginClientContext } from "@getpaseo/plugin/client";',
      );
      await writeFile(
        path.join(entries.directory, "shared/labels.ts"),
        'import type { Value } from "typed-helper"; export const clientLabel: Value = "client"; export const serverLabel: Value = "server";',
      );
      await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
      await writeFile(referencedFile, "export type Neutral = string;");
      await expect(compilePlugin(entries)).resolves.toMatchObject({
        clientBundle: expect.any(String),
        serverBundle: expect.any(String),
      });
    },
  );

  it("checks the physical owner of type-only symlinks", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      path.join(entries.directory, "server/context.ts"),
      "export type Value = string;",
    );
    await symlink(
      path.join(entries.directory, "server/context.ts"),
      path.join(entries.directory, "shared/context.ts"),
    );
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      'import type { Value } from "./context"; export const clientLabel: Value = "client"; export const serverLabel: Value = "server";',
    );
    await expect(compilePlugin(entries)).rejects.toThrow("server-only module");
  });

  it("resolves type-only path aliases from the plugin tsconfig", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      path.join(entries.directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "shared-types": ["shared/types.ts"] } },
      }),
    );
    await writeFile(path.join(entries.directory, "shared/types.ts"), "export type Value = string;");
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      'import type { Value } from "shared-types"; export const clientLabel: Value = "client"; export const serverLabel: Value = "server";',
    );
    await expect(compilePlugin(entries)).resolves.toMatchObject({
      clientBundle: expect.any(String),
      serverBundle: expect.any(String),
    });
    await writeFile(
      path.join(entries.directory, "shared/types.ts"),
      'export type { PluginClientContext as Value } from "@getpaseo/plugin/client";',
    );
    await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
  });

  it.each([
    { specifier: "@getpaseo/plugin/client", importKind: "import type" },
    { specifier: "@getpaseo/plugin/server", importKind: "import type" },
    { specifier: "@getpaseo/plugin/client", importKind: "import" },
    { specifier: "@getpaseo/plugin/server", importKind: "import" },
  ])(
    "rejects transitive declaration dependencies on $specifier through $importKind",
    async ({ specifier, importKind }) => {
      const entries = await createSplitPlugin();
      const dependency = path.join(entries.directory, "node_modules/typed-helper");
      await mkdir(dependency, { recursive: true });
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "typed-helper", main: "index.js", types: "index.d.ts" }),
      );
      await writeFile(path.join(dependency, "index.js"), "export {};");
      await writeFile(
        path.join(dependency, "index.d.ts"),
        'export type { Context } from "./context";',
      );
      const context = specifier.endsWith("client") ? "PluginClientContext" : "PluginServerContext";
      await writeFile(
        path.join(dependency, "context.d.ts"),
        `export type { ${context} as Context } from "${specifier}";`,
      );
      await writeFile(
        path.join(entries.directory, "shared/labels.ts"),
        `${importKind} { Context } from "typed-helper"; export type Value = Context; export const clientLabel = "client"; export const serverLabel = "server";`,
      );
      await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
    },
  );

  it("checks files reached only through type imports", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      path.join(entries.directory, "shared/types.ts"),
      'export type { PluginClientContext } from "@getpaseo/plugin/client";',
    );
    await writeFile(
      path.join(entries.directory, "shared/labels.ts"),
      'export type { PluginClientContext } from "./types"; export const clientLabel = "client"; export const serverLabel = "server";',
    );
    await expect(compilePlugin(entries)).rejects.toThrow("plugin shared");
  });

  it.each([
    "@paseo/plugin",
    "@getpaseo/plugin/react-native",
    "@getpaseo/plugin/ui",
    "@getpaseo/plugin/provider",
    "@getpaseo/plugin/acp",
    "@getpaseo/plugin/host",
  ])("rejects retired entry %s", async (specifier) => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.server,
      `import * as sdk from "${specifier}"; export default function contribute() { return sdk; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow(specifier);
  });

  it("builds each runtime from its own entry and shares neutral modules", async () => {
    const entries = await createSplitPlugin();

    const { clientBundle, serverBundle } = await compilePlugin(entries);

    expect(clientBundle).toContain("Client contribution");
    expect(clientBundle).not.toContain("Server contribution");
    expect(serverBundle).toContain("Server contribution");
    expect(serverBundle).not.toContain("Client contribution");
  });

  it("uses the automatic JSX runtime without a React import", async () => {
    const entries = await createSplitPlugin();
    const { clientBundle } = await compilePlugin(entries);
    expect(clientBundle).toContain("react/jsx-runtime");
    expect(clientBundle).not.toContain("React.createElement");
  });

  it("lowers async callbacks before Hermes evaluates the client bundle", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.client,
      `export default async function contribute() {
  await Promise.resolve();
  return () => undefined;
}`,
    );
    const { clientBundle } = await compilePlugin(entries);
    expect(clientBundle).not.toContain("async function contribute");
    expect(clientBundle).toContain("__async");
  });

  it("rejects node imports from the client entry", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.client,
      `import { readFile } from "node:fs";
export default function contribute() { void readFile; return () => undefined; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow(
      "Node module cannot be imported into the plugin client bundle: node:fs",
    );
  });

  it("rejects server directory imports from the client bundle", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.client,
      `import { handler } from "./server/handler";
export default function contribute() { void handler; return () => undefined; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
  });

  it("rejects client directory imports from the server bundle", async () => {
    const entries = await createSplitPlugin();
    await writeFile(
      entries.server,
      `import { Surface } from "./client/surface";
export default function contribute() { void Surface; return () => undefined; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow(
      "client-only module cannot be imported into the plugin server bundle",
    );
  });

  it("rejects modules imported directly from the plugin root", async () => {
    const entries = await createSplitPlugin();
    const helper = path.join(entries.directory, "helper.ts");
    await writeFile(helper, "export const value = 1;");
    await writeFile(
      entries.server,
      `import { value } from "./helper";
export default function contribute() { void value; return () => undefined; }`,
    );
    await expect(compilePlugin(entries)).rejects.toThrow(
      `Plugin modules belong in client/, server/, or shared/: ${path.join(realpathSync.native(entries.directory), "helper")}`,
    );
  });

  it("rejects relative imports that escape the plugin root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-parent-"));
    temporaryDirectories.push(parent);
    const pluginDirectory = path.join(parent, "plugin");
    const server = path.join(pluginDirectory, "index.server.ts");
    await mkdir(pluginDirectory);
    await Promise.all([
      writeFile(path.join(parent, "secret.ts"), `export const secret = "outside";`),
      writeFile(
        server,
        `import { secret } from "../secret";
export default function contribute() { void secret; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin({ client: null, server })).rejects.toThrow(
      `Plugin modules belong in client/, server/, or shared/: ${path.join(realpathSync.native(parent), "secret")}`,
    );
  });

  it("rejects absolute imports from outside the plugin root", async () => {
    const entries = await createSplitPlugin();
    const outsideDirectory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outside = path.join(outsideDirectory, "secret.ts");
    await writeFile(outside, `export const secret = "outside";`);
    await writeFile(
      entries.client,
      `import { secret } from ${JSON.stringify(outside)};
export default function contribute() { void secret; return () => undefined; }`,
    );

    await expect(compilePlugin(entries)).rejects.toThrow(
      `Plugin modules belong in client/, server/, or shared/: ${realpathSync.native(outside)}`,
    );
  });

  it("rejects plugin-authored relative imports that escape into node_modules", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-plugin-node-modules-parent-"));
    temporaryDirectories.push(parent);
    const pluginDirectory = path.join(parent, "plugin");
    const server = path.join(pluginDirectory, "index.server.ts");
    const outside = path.join(parent, "node_modules", "secret.ts");
    await Promise.all([mkdir(pluginDirectory), mkdir(path.dirname(outside))]);
    await Promise.all([
      writeFile(outside, `export const secret = "outside";`),
      writeFile(
        server,
        `import { secret } from "../node_modules/secret";
export default function contribute() { void secret; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin({ client: null, server })).rejects.toThrow(
      `Plugin modules belong in client/, server/, or shared/: ${path.join(realpathSync.native(parent), "node_modules", "secret")}`,
    );
  });

  it("keeps nested modules owned by their top-level runtime directory", async () => {
    const entries = await createSplitPlugin();
    const nestedClient = path.join(entries.directory, "client", "feature", "server");
    const nestedServer = path.join(entries.directory, "server", "feature", "client");
    const nestedShared = path.join(entries.directory, "shared", "feature");
    await Promise.all([
      mkdir(nestedClient, { recursive: true }),
      mkdir(nestedServer, { recursive: true }),
      mkdir(nestedShared, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(nestedShared, "value.ts"), `export const value = "shared nested";`),
      writeFile(
        path.join(nestedClient, "value.ts"),
        `export { value } from "../../../shared/feature/value";`,
      ),
      writeFile(
        path.join(nestedServer, "value.ts"),
        `export { value } from "../../../shared/feature/value";`,
      ),
      writeFile(
        entries.client,
        `import { value } from "./client/feature/server/value";
export default function contribute() { void value; return () => undefined; }`,
      ),
      writeFile(
        entries.server,
        `import { value } from "./server/feature/client/value";
export default function contribute() { void value; return () => undefined; }`,
      ),
    ]);

    const { clientBundle, serverBundle } = await compilePlugin(entries);

    expect(clientBundle).toContain("shared nested");
    expect(serverBundle).toContain("shared nested");
  });

  it("does not classify dependency directories as plugin runtime boundaries", async () => {
    const entries = await createSplitPlugin();
    const dependency = path.join(entries.directory, "node_modules", "fixture-dependency");
    await mkdir(path.join(dependency, "client"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      ),
      writeFile(
        path.join(dependency, "index.js"),
        `const { label } = require("./client/label");
module.exports = { label };`,
      ),
      writeFile(
        path.join(dependency, "client", "label.js"),
        `module.exports = { label: "dependency client directory" };`,
      ),
      writeFile(
        entries.server,
        `import { label } from "fixture-dependency";
export default function contribute() {
  void label;
  return () => undefined;
}`,
      ),
    ]);

    const { serverBundle } = await compilePlugin(entries);

    expect(serverBundle).toContain("dependency client directory");
  });

  it("rejects dependency-relative imports that escape into the opposite runtime", async () => {
    const entries = await createSplitPlugin();
    const dependency = path.join(entries.directory, "node_modules", "fixture-dependency");
    await mkdir(dependency, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      ),
      writeFile(
        path.join(dependency, "index.js"),
        `module.exports = require("../../server/handler");`,
      ),
      writeFile(
        entries.client,
        `import handler from "fixture-dependency";
export default function contribute() { void handler; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin(entries)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
  });

  it.each(["file", "directory"])(
    "preserves authored ownership through root and %s aliases",
    async (aliasKind) => {
      const entries = await createSplitPlugin();
      const rootAlias = await createRootAlias(entries.directory);
      const sharedValue = path.join(entries.directory, "shared/value.ts");
      await writeFile(sharedValue, 'export const value = "shared";');
      if (aliasKind === "file") {
        await symlink(sharedValue, path.join(entries.directory, "server/alias.ts"));
      } else {
        await rm(path.join(entries.directory, "server"), { recursive: true });
        await symlink(
          path.join(entries.directory, "shared"),
          path.join(entries.directory, "server"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      await writeFile(
        entries.client,
        `export { value } from ${JSON.stringify(path.join(rootAlias, "server", aliasKind === "file" ? "alias.ts" : "value.ts"))};`,
      );
      await expect(compilePlugin({ client: entries.client, server: null })).rejects.toThrow(
        "server-only module",
      );
      await writeFile(
        entries.client,
        `export { value } from ${JSON.stringify(path.join(rootAlias, "shared/value.ts"))};`,
      );
      await expect(compilePlugin({ client: entries.client, server: null })).resolves.toMatchObject({
        clientBundle: expect.stringContaining("shared"),
      });
    },
  );

  it("rejects generated React imports in dependencies reached through shared symlinks", async () => {
    const entries = await createSplitPlugin();
    const rootAlias = await createRootAlias(entries.directory);
    const dependency = path.join(entries.directory, "node_modules/decoration");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "decoration", main: "index.tsx" }),
    );
    await writeFile(path.join(dependency, "index.tsx"), "export const decoration = <></>;");
    await writeFile(
      path.join(entries.directory, "shared/decoration.ts"),
      'export { decoration } from "decoration";',
    );
    await symlink(
      path.join(rootAlias, "shared/decoration.ts"),
      path.join(entries.directory, "client/decoration.ts"),
    );
    await writeFile(entries.client, 'export { decoration } from "./client/decoration";');
    await expect(compilePlugin({ client: entries.client, server: null })).rejects.toThrow(
      "plugin shared",
    );
  });

  it.each([false, true])("classifies symlink targets through a root alias: %s", async (aliased) => {
    const entries = await createSplitPlugin();
    const targetRoot = aliased ? await createRootAlias(entries.directory) : entries.directory;
    const link = path.join(entries.directory, "client", "handler.ts");
    await symlink(path.join(targetRoot, "server", "handler.ts"), link);
    await writeFile(
      entries.client,
      `import { handler } from "./client/handler";
export default function contribute() { void handler; return () => undefined; }`,
    );

    await expect(compilePlugin(entries)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
  });

  it("classifies bare package imports by their canonical target", async () => {
    const entries = await createSplitPlugin();
    const dependency = path.join(entries.directory, "node_modules", "fixture-dependency");
    await mkdir(dependency, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      ),
      symlink(
        path.join(entries.directory, "server", "handler.ts"),
        path.join(dependency, "index.js"),
      ),
      writeFile(
        entries.client,
        `import { handler } from "fixture-dependency";
export default function contribute() { void handler; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin(entries)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
  });

  it("allows linked dependencies to resolve within their own package root", async () => {
    const entries = await createSplitPlugin();
    const linkedPackage = await mkdtemp(path.join(tmpdir(), "paseo-plugin-linked-dependency-"));
    temporaryDirectories.push(linkedPackage);
    await mkdir(path.join(entries.directory, "node_modules"));
    await Promise.all([
      writeFile(
        path.join(linkedPackage, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      ),
      writeFile(path.join(linkedPackage, "index.js"), `module.exports = require("./value");`),
      writeFile(path.join(linkedPackage, "value.js"), `module.exports = "linked dependency";`),
      symlink(
        linkedPackage,
        path.join(entries.directory, "node_modules", "fixture-dependency"),
        process.platform === "win32" ? "junction" : "dir",
      ),
      writeFile(
        entries.server,
        `import value from "fixture-dependency";
export default function contribute() { void value; return () => undefined; }`,
      ),
    ]);

    const { serverBundle } = await compilePlugin(entries);

    expect(serverBundle).toContain("linked dependency");
  });

  it.each([false, true])(
    "rejects plugin manifests as linked roots through an alias: %s",
    async (aliased) => {
      const entries = await createSplitPlugin();
      const targetRoot = aliased ? await createRootAlias(entries.directory) : entries.directory;
      const dependency = path.join(entries.directory, "node_modules", "fixture-dependency");
      const secret = path.join(entries.directory, "secret.ts");
      await mkdir(dependency, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(entries.directory, "package.json"),
          JSON.stringify({ name: "fixture-dependency" }),
        ),
        writeFile(
          path.join(dependency, "package.json"),
          JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
        ),
        writeFile(secret, `export const secret = "plugin root";`),
        symlink(path.join(targetRoot, "secret.ts"), path.join(dependency, "index.js")),
        writeFile(
          entries.client,
          `import { secret } from "fixture-dependency";
export default function contribute() { void secret; return () => undefined; }`,
        ),
      ]);

      await expect(compilePlugin(entries)).rejects.toThrow(
        `Plugin modules belong in client/, server/, or shared/: ${realpathSync.native(secret)}`,
      );
    },
  );

  it("does not let remembered linked roots hide plugin-local runtime boundaries", async () => {
    const entries = await createSplitPlugin();
    const linkedPackage = await mkdtemp(path.join(tmpdir(), "paseo-plugin-linked-boundary-"));
    temporaryDirectories.push(linkedPackage);
    await mkdir(path.join(entries.directory, "node_modules"));
    await Promise.all([
      writeFile(
        path.join(linkedPackage, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      ),
      writeFile(path.join(linkedPackage, "index.js"), `module.exports = "linked dependency";`),
      writeFile(path.join(linkedPackage, "secret.ts"), `export const secret = "linked secret";`),
      symlink(
        linkedPackage,
        path.join(entries.directory, "node_modules", "fixture-dependency"),
        process.platform === "win32" ? "junction" : "dir",
      ),
      symlink(
        path.join(linkedPackage, "secret.ts"),
        path.join(entries.directory, "server", "linked-secret.ts"),
      ),
      writeFile(
        entries.client,
        `import value from "fixture-dependency";
import { secret } from "./server/linked-secret";
export default function contribute() { void value; void secret; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin(entries)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
  });

  it("builds a single runtime when the other entry is absent", async () => {
    const entries = await createSplitPlugin();
    const { clientBundle, serverBundle } = await compilePlugin({
      client: entries.client,
      server: null,
    });
    expect(clientBundle).toContain("Client contribution");
    expect(serverBundle).toBeNull();
  });
});
