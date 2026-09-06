import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../../../", import.meta.url);

async function readPackage(workspace: string): Promise<{
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}> {
  return JSON.parse(
    await readFile(new URL(`packages/${workspace}/package.json`, repoRoot), "utf8"),
  );
}

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(new URL(`${entry.name}/`, directory))));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    files.push(new URL(entry.name, directory));
  }
  return files;
}

/** "use-sync-external-store/shim/with-selector" -> "use-sync-external-store" */
function packageOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** Bare specifiers the SDK imports for their value, so a `require` survives compilation. */
async function runtimeImportsOfPluginSdk(): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const file of await sourceFiles(new URL("packages/plugin/src/", repoRoot))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+"([^"]+)";$/gm)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      packages.add(packageOf(specifier));
    }
  }
  return packages;
}

describe("plugin SDK peers", () => {
  // The plugin host in plugin-process.ts requires @getpaseo/plugin from disk inside the daemon,
  // where nothing supplies the SDK's peers the way the renderer does. electron-builder collects
  // declared dependencies only, so a peer nobody declares never reaches app.asar and every plugin
  // dies with "Cannot find module" in a packaged desktop build while dev keeps working off the
  // hoisted root node_modules.
  it("are declared as real dependencies of the daemon that loads the SDK", async () => {
    const [sdk, server] = await Promise.all([readPackage("plugin"), readPackage("server")]);
    const imported = await runtimeImportsOfPluginSdk();
    const peers = Object.keys(sdk.peerDependencies ?? {}).filter((name) => imported.has(name));

    expect(peers).toContain("react");
    for (const peer of peers) {
      expect(
        server.dependencies?.[peer],
        `@getpaseo/server must declare ${peer}: @getpaseo/plugin imports it for its value and only declares it as a peer`,
      ).toBeDefined();
    }
  });

  it("covers every bare import the host pulls in transitively", async () => {
    const sdk = await readPackage("plugin");
    const imported = await runtimeImportsOfPluginSdk();
    const declared = new Set([
      ...Object.keys(sdk.dependencies ?? {}),
      ...Object.keys(sdk.peerDependencies ?? {}),
    ]);

    for (const name of imported) {
      expect(declared, `@getpaseo/plugin imports ${name} without declaring it`).toContain(name);
    }
  });
});
