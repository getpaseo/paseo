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

describe("plugin runtime entries", () => {
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
      `Plugin modules belong in client/, server/, or shared/: ${path.join(entries.directory, "helper")}`,
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
      `Plugin modules belong in client/, server/, or shared/: ${path.join(parent, "secret")}`,
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
      `Plugin modules belong in client/, server/, or shared/: ${outside}`,
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
      `Plugin modules belong in client/, server/, or shared/: ${path.join(parent, "node_modules", "secret")}`,
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

  it("classifies symlinks by their canonical target", async () => {
    const entries = await createSplitPlugin();
    const link = path.join(entries.directory, "client", "handler.ts");
    await symlink(path.join(entries.directory, "server", "handler.ts"), link);
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

  it("does not treat the plugin package manifest as a linked dependency root", async () => {
    const entries = await createSplitPlugin();
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
      symlink(secret, path.join(dependency, "index.js")),
      writeFile(
        entries.client,
        `import { secret } from "fixture-dependency";
export default function contribute() { void secret; return () => undefined; }`,
      ),
    ]);

    await expect(compilePlugin(entries)).rejects.toThrow(
      `Plugin modules belong in client/, server/, or shared/: ${secret}`,
    );
  });

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
