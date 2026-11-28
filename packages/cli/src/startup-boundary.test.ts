import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

const FORBIDDEN_PATTERNS = [
  /ws-outbound\.aot/,
  /packages\/protocol\/(?:dist|src)\/messages\.[jt]s$/,
  /node_modules\/zod\//,
  /node_modules\/qrcode\//,
  /node_modules\/pngjs\//,
  /node_modules\/ajv\//,
  /node_modules\/yaml\//,
  /node_modules\/mime-db\//,
  /node_modules\/bcryptjs\//,
  /packages\/relay\//,
  /@getpaseo\/relay/,
  /node_modules\/chalk\//,
  /node_modules\/@clack\//,
  /persisted-config\.[jt]s$/,
];

function collectStaticInputs(metafile: Metafile, outputKey: string): string[] {
  const visitedOutputs = new Set<string>();
  const collectedInputs = new Set<string>();
  const queue = [outputKey];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visitedOutputs.has(current)) continue;
    visitedOutputs.add(current);
    const output = metafile.outputs[current];
    if (!output) continue;
    for (const input of Object.keys(output.inputs)) {
      collectedInputs.add(input);
    }
    for (const imp of output.imports) {
      if (imp.kind === "dynamic-import") continue;
      if (imp.external) {
        collectedInputs.add(imp.path);
        continue;
      }
      queue.push(imp.path);
    }
  }

  return [...collectedInputs];
}

async function analyzeEntryStaticGraph(entryRelPath: string): Promise<string[]> {
  const result = await build({
    entryPoints: { entry: path.join(packageRoot, entryRelPath) },
    outdir: path.join(packageRoot, ".tmp-boundary-check"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    metafile: true,
    external: ["bufferutil", "utf-8-validate"],
    plugins: [
      {
        name: "external-server-except-daemon-files",
        setup(buildContext) {
          buildContext.onResolve({ filter: /^@getpaseo\/server(\/.*)?$/ }, (args) => {
            if (args.path === "@getpaseo/server/daemon-files") return null;
            return { path: args.path, external: true };
          });
        },
      },
    ],
    logLevel: "silent",
  });

  const entryOutputKey = Object.keys(result.metafile.outputs).find((key) =>
    key.endsWith("/entry.js"),
  );
  if (!entryOutputKey) throw new Error(`Entry output not found for ${entryRelPath}`);
  return collectStaticInputs(result.metafile, entryOutputKey);
}

function isForbiddenImport(value: string): boolean {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

describe("CLI startup import boundary", () => {
  it.each([
    ["CLI entrypoint (--version / --help)", "src/index.ts"],
    ["thin agent ls command", "src/commands/agent/ls.ts"],
    ["thin host command", "src/commands/host/index.ts"],
    ["thin provider ls command", "src/commands/provider/ls.ts"],
    ["thin workspace ls command", "src/commands/workspace/ls.ts"],
  ])(
    "%s does not statically pull forbidden heavy dependencies",
    async (_label, entryRelPath) => {
      const staticInputs = await analyzeEntryStaticGraph(entryRelPath);
      const violations = staticInputs.filter(isForbiddenImport);
      expect(violations).toEqual([]);
    },
    30_000,
  );

  it("bundled dist/index.js serves --version without loading heavy modules at runtime", () => {
    const distEntry = path.join(packageRoot, "dist/index.js");
    if (!existsSync(distEntry)) return;

    const hookCode =
      'export async function load(url, context, nextLoad) { process.stderr.write("LOAD:" + url + "\\n"); return nextLoad(url, context); }';
    const script = `
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hookCode)}));
      process.argv = ["node", "paseo", "--version"];
      await import(${JSON.stringify(distEntry)});
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
    const loadedFileUrls = run.stderr
      .split("\n")
      .filter((line) => line.startsWith("LOAD:"))
      .map((line) => line.slice("LOAD:".length))
      .filter((url) => url.startsWith("file://"));
    expect(loadedFileUrls.length).toBeGreaterThan(0);
    expect(loadedFileUrls.length).toBeLessThan(12);
    const forbiddenLoaded = loadedFileUrls.filter(isForbiddenImport);
    expect(forbiddenLoaded).toEqual([]);
  });
});
