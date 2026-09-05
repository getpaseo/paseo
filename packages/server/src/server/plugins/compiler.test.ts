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
  it("strips direct registrations when a var redeclares the context parameter", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  var plugin;
  plugin.addTool({});
  return () => undefined;
}
`,
    );

    const { clientBundle } = await compilePlugin(entryPath);
    expect(clientBundle).not.toContain("addTool");
  });

  it.each([
    ["a named function declaration", "function plugin() { return plugin; }"],
    ["a named function expression", "const register = function plugin() { return plugin; };"],
    [
      "a named class declaration",
      "{ class plugin { [plugin]() {} static value = plugin; static { void plugin; } } }",
    ],
    [
      "a named class expression",
      "const Example = class plugin extends plugin { [plugin]() {} static value = plugin; static { void plugin; } };",
    ],
  ])("accepts %s that shadows the default context", async (_description, declaration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${declaration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    ["a class declaration", "class Example extends plugin {}"],
    ["a class expression", "const Example = class Named extends plugin {};"],
    ["a computed class key", "class Example { [plugin]() {} }"],
    ["a class static block", "class Example { static { void plugin; } }"],
  ])("rejects a default context escape from %s extends", async (_description, declaration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${declaration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it("ignores type-only method signatures and declarations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  interface Shape {
    [plugin]: typeof plugin;
    method(value: typeof plugin): typeof plugin;
  }
  type Alias = {
    [plugin]: typeof plugin;
    method(value: typeof plugin): typeof plugin;
  };
  declare class Example {
    [plugin](): typeof plugin;
  }
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    ["TypeScript wrappers", "const value = (plugin as unknown satisfies unknown)!;"],
    ["decorators", "@plugin class Example {}"],
    ["default values", "const object = { register(value = plugin) {} };"],
  ])("still analyzes runtime expressions in %s", async (_description, expression) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${expression}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it("does not reject a direct registration in a nested function with a shadowing parameter", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  function nested(plugin) {
    plugin.addTool({});
  }
  nested({});
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    ["an object method", "const object = { register() { plugin.addTool({}); } };"],
    ["a class method", "class Example { register() { plugin.addTool({}); } }"],
    ["a class private method", "class Example { #register() { plugin.addTool({}); } }"],
  ])("rejects a registration nested in %s", async (_description, declaration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${declaration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/helper|default context/i);
  });

  it.each([
    ["an object method", "const object = { register(plugin) { plugin.addTool({}); } };"],
    ["a class method", "class Example { register(plugin) { plugin.addTool({}); } }"],
    ["a class private method", "class Example { #register(plugin) { plugin.addTool({}); } }"],
  ])("accepts a shadowed method parameter in %s", async (_description, declaration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${declaration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    ["a default initializer", "const object = { register(value = plugin) {} };"],
    ["a destructuring default", "const object = { register({ value = plugin }) {} };"],
  ])("rejects a default context escape from %s", async (_description, declaration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${declaration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it("does not reject unrelated local member helpers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  const object = { addTool() {} };
  var register = object.addTool;
  register({});
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    "const alias = plugin;\nalias.addTool({});",
    "let alias;\nalias = plugin;\nalias.addTool({});",
    "const register = plugin.addTool;\nregister({});",
    "const { addTool } = plugin;\naddTool({});",
    "const { addTool: register } = plugin;\nregister({});",
    'plugin["addTool"]({});',
    'const method = "addTool";\nplugin[method]({});',
  ])(
    "rejects indirect registration calls that could cross bundle boundaries",
    async (registration) => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
      temporaryDirectories.push(directory);
      const entryPath = path.join(directory, "index.ts");
      await writeFile(
        entryPath,
        `export default function contribute(plugin) {
  ${registration}
  return () => undefined;
}
`,
      );

      await expect(compilePlugin(entryPath)).rejects.toThrow(/direct.*context|default context/i);
    },
  );

  it.each([
    "plugin.addTool({ context: plugin });",
    "plugin.addTool({ nested: { context: plugin } });",
    "plugin.addTool({ values: [plugin] });",
    "plugin.addTool({ handler: () => plugin.addTool({}) });",
  ])(
    "rejects context escapes and nested registrations in registration arguments: %s",
    async (registration) => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
      temporaryDirectories.push(directory);
      const entryPath = path.join(directory, "index.ts");
      await writeFile(
        entryPath,
        `export default function contribute(plugin) {
  ${registration}
  return () => undefined;
}
`,
      );

      await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
    },
  );

  it("ignores noncomputed property names and ordinary object keys while analyzing arguments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  plugin.addTool({
    plugin: "ordinary key",
    nested: { plugin: true },
    value: { plugin: "member key" }.plugin,
  });
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).resolves.toBeDefined();
  });

  it.each([
    'plugin.addTool({ [plugin]: "computed key" });',
    "plugin.addTool({ plugin });",
    "plugin.addTool({ value: plugin.addTool });",
  ])("rejects actual context binding uses in registration arguments: %s", async (registration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${registration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it.each([
    "helper(plugin);",
    "const stored = plugin;",
    "return plugin;",
    "const stored = { context: plugin };",
    "const stored = { ...plugin };",
  ])("rejects default context escape: %s", async (registration) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  ${registration}
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it("rejects passing the default context to an imported helper", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "helper.ts"),
      "export function forward(value) { return value; }\n",
    );
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `import { forward } from "./helper";

export default function contribute(plugin) {
  forward(plugin);
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/default context|direct.*context/i);
  });

  it("rejects a helper that closes over the default context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `export default function contribute(plugin) {
  function register() {
    plugin.addTool({});
  }
  register();
  return () => undefined;
}
`,
    );

    await expect(compilePlugin(entryPath)).rejects.toThrow(/helper|default context/i);
  });

  it("keeps direct server and client imports aligned with each bundle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `import { surface } from "./main.client";
import { handler, ping } from "./service.server";

export default function contribute(plugin) {
  plugin.handle(ping, handler);
  plugin.addSurface("main", surface);
  return () => undefined;
}
`,
    );
    await writeFile(
      path.join(directory, "main.client.ts"),
      `export function surface() { return "client-surface"; }
`,
    );
    await writeFile(
      path.join(directory, "service.server.ts"),
      `export const ping = { name: "ping", input: {}, output: {} };
export function handler() { return "server-handler"; }
`,
    );

    const { clientBundle, serverBundle } = await compilePlugin(entryPath);
    expect(clientBundle).toContain("client-surface");
    expect(clientBundle).not.toContain("server-handler");
    expect(serverBundle).toContain("server-handler");
    expect(serverBundle).not.toContain("client-surface");
  });

  it("keeps model-facing tools out of the client bundle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `import { lookup } from "./lookup.server";

export default function contribute(plugin) {
  plugin.addTool(lookup);
  return () => undefined;
}
`,
    );
    await writeFile(
      path.join(directory, "lookup.server.ts"),
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

export const lookup = defineTool({
  name: "lookup",
  title: "Lookup",
  description: "Look something up.",
  input: z.object({ query: z.string() }),
  handler: async (input) => ({ value: input.query }),
});
`,
    );

    const { clientBundle, serverBundle } = await compilePlugin(entryPath);
    expect(clientBundle).not.toContain("lookup");
    expect(serverBundle).toContain("lookup");
  });

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
