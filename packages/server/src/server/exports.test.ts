import { expect, test } from "vitest";

test("keeps daemon-client APIs out of the server public entry", async () => {
  const serverExports = await import("./exports.js");

  expect(serverExports.createPaseoDaemon).toBeTypeOf("function");
  expect(serverExports.resolvePaseoHome).toBeTypeOf("function");

  for (const name of [
    "DaemonClient",
    "DaemonClientConfig",
    "ConnectionState",
    "DaemonEvent",
    "WebSocketFactory",
    "WebSocketLike",
  ]) {
    expect(serverExports).not.toHaveProperty(name);
  }
});

// Keep the emitted dependency tree intact: production runs unbundled modules,
// so tree-shaking must not hide the cost of an unused re-export.
test.each([
  ["desktop daemon management", "../../../desktop/src/daemon/daemon-manager.ts"],
  ["supervisor", "../../scripts/supervisor-entrypoint.ts"],
  ["daemon control", "@getpaseo/server/daemon-control"],
  ["configuration without the session admission resolver", "@getpaseo/server/configuration"],
])("%s does not load the daemon runtime or wire schemas", async (_name, entry) => {
  const inputs = await runtimeDependencies(entry);
  expect(inputs.filter((file) => /\/(?:bootstrap|messages)\.[jt]s$/.test(file))).toEqual([]);
});

test("CLI command registration does not load the daemon implementation", async () => {
  const inputs = await runtimeDependencies("../../../cli/src/cli.ts");
  expect(
    inputs.filter((file) => /\/(?:bootstrap|agent-manager|session)\.[jt]s$/.test(file)),
  ).toEqual([]);
});

async function runtimeDependencies(entry: string): Promise<string[]> {
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const { isAbsolute } = await import("node:path");
  const result = await build({
    stdin: {
      contents: `import ${JSON.stringify(entry.startsWith("@") ? entry : fileURLToPath(new URL(entry, import.meta.url)))};`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    metafile: true,
    treeShaking: false,
    platform: "node",
    // Server unit CI builds dependency workspaces, then tests server source.
    conditions: ["source"],
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "external-vendors",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            if (!isAbsolute(path) && !path.startsWith("@getpaseo/")) {
              return { path, external: true };
            }
          });
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.length).toBeGreaterThan(1);
  return inputs;
}
