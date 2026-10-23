import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as server from "./server/index.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const entries = {
  ".": "shared",
  "./server": "server",
  "./server/provider": "server",
  "./server/usage": "server",
  "./server/acp": "server",
  "./client": "client",
  "./client/host": "client",
  "./client/ui": "client",
} as const;
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Compatibility entrypoints inherit the boundary of their one re-export target.
const compatibilityEntries = Object.keys(manifest.exports).filter((entry) => {
  const file = path.resolve(sourceDirectory, "..", manifest.exports[entry].source);
  return readFileSync(file, "utf8").startsWith("// COMPAT(");
});
const uiDependency = /^(react(?:-dom|-native)?|use-sync-external-store)(\/|$)/;
const serverModule = /^server\//;
const clientModule = /^client\//;

function resolveLocal(importer: string, specifier: string): string {
  const base = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, ""));
  const candidates = specifier.endsWith(".json") ? [base] : [base + ".ts", base + ".tsx"];
  const result = candidates.find(existsSync);
  if (!result) throw new Error(`Cannot resolve ${specifier} from ${importer}`);
  return result;
}

function boundaryViolations(entry: string, runtime: "shared" | "server" | "client"): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    // Includes type imports, re-exports, import types, and literal dynamic imports.
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const { fileName: specifier } of imports) {
      const label = `${path.relative(sourceDirectory, file)} -> ${specifier}`;
      if (specifier.startsWith(".")) {
        const local = resolveLocal(file, specifier);
        const module = path
          .relative(sourceDirectory, local)
          .replace(/\\/g, "/")
          .replace(/\.tsx?$/, ".js");
        if (runtime !== "client" && clientModule.test(module)) violations.push(label);
        if (runtime !== "server" && serverModule.test(module)) violations.push(label);
        pending.push(local);
      } else if (runtime === "shared") {
        if (specifier !== "zod" && specifier !== "@getpaseo/protocol/agent-types")
          violations.push(label);
      } else if (runtime === "server") {
        if (uiDependency.test(specifier) || /^@getpaseo\/plugin\/client(\/|$)/.test(specifier))
          violations.push(label);
      } else if (isBuiltin(specifier) || /^@getpaseo\/plugin\/server(\/|$)/.test(specifier)) {
        violations.push(label);
      }
    }
  }
  return violations;
}

function typeErrors(code: string): string[] {
  const configPath = path.resolve(sourceDirectory, "../tsconfig.examples.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  const file = path.resolve(
    sourceDirectory,
    "../../../plugin-examples/skill-example/client/example.tsx",
  );
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) =>
    path.resolve(name) === file
      ? ts.createSourceFile(name, code, language)
      : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => path.resolve(name) === file || ts.sys.fileExists(name);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
describe("plugin SDK import boundaries", () => {
  it("publishes process capabilities without their Windows implementation helpers", () => {
    expect(Object.keys(server).sort()).toEqual(["execCommand", "spawnProcess", "terminateProcess"]);
  });

  it("classifies every published entry", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [...Object.keys(entries), ...compatibilityEntries].sort(),
    );
  });

  it.each(compatibilityEntries)("%s only re-exports the UI entry", (entry) => {
    const source = readFileSync(
      path.resolve(sourceDirectory, "..", manifest.exports[entry].source),
      "utf8",
    );
    expect(source.replace(/\/\/[^\n]*|\/\*[^]*?\*\//g, "").trim()).toBe('export * from "./ui.js";');
  });

  it.each(Object.entries(entries))(
    "%s respects its %s boundary, including type dependencies",
    (specifier, runtime) => {
      const name =
        specifier === "."
          ? "index"
          : specifier.slice(2) +
            (specifier === "./client" || specifier === "./server" ? "/index" : "");
      expect(boundaryViolations(path.join(sourceDirectory, `${name}.ts`), runtime)).toEqual([]);
    },
  );
});

describe("plugin example import boundaries", () => {
  const examples = path.resolve(sourceDirectory, "../../../plugin-examples");
  const files = readdirSync(examples, { recursive: true }).filter(
    (file) => !file.split(path.sep).includes("node_modules") && /(?<!\.test)\.tsx?$/.test(file),
  );
  const owner = (file: string) => {
    const [, directory] = path.relative(examples, file).split(path.sep);
    if (directory?.startsWith("index.client.")) return "client";
    if (directory?.startsWith("index.server.")) return "server";
    return directory;
  };

  it.each(files)("%s respects runtime ownership, including type imports", (relative) => {
    const file = path.join(examples, relative);
    const runtime = owner(file);
    expect(["shared", "client", "server"]).toContain(runtime);
    const violations: string[] = [];
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, "utf8"), true, true)
      .importedFiles) {
      if (specifier.startsWith(".")) {
        const imported = owner(resolveLocal(file, specifier));
        if (imported !== "shared" && imported !== runtime) violations.push(specifier);
      } else if (specifier.startsWith("@getpaseo/plugin")) {
        const entry = specifier.replace("@getpaseo/plugin", ".") as keyof typeof entries;
        if (
          entry === "./client/host" ||
          !(entry in entries) ||
          (entries[entry] !== "shared" && entries[entry] !== runtime)
        )
          violations.push(specifier);
      } else if (
        (runtime !== "client" && uiDependency.test(specifier)) ||
        (runtime !== "server" && isBuiltin(specifier))
      ) {
        violations.push(specifier);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("plugin panel SDK boundary", () => {
  it("accepts uniform params and persisted tab state alongside 0.12 panels", () => {
    expect(
      typeErrors(`
      import { type PluginClientContext, type PluginFilePanelProps, type PluginWorkspacePanelProps, type PluginAgentPanelProps, type PluginTab, useTabState } from "@getpaseo/plugin/client";
      import { z } from "zod";
      function FilePanel({ params, revision, tab, file }: PluginFilePanelProps) {
        const [state, setState] = useTabState(tab, z.object({ view: z.enum(["preview", "source"]) }), { view: "preview" });
        setState({ view: "source" });
        tab.setState({ nested: [true, null, 3] });
        // @ts-expect-error only JSON state crosses the host boundary
        tab.setState(() => {});
        // @ts-expect-error params belong to the opener
        params.path = "other";
        return null;
      }
      function OldWorkspace({ context, workspaceId }: PluginWorkspacePanelProps) { return null; }
      function OldAgent({ context, workspaceId, agentId }: PluginAgentPanelProps) { return null; }
      function Agent({ params }: PluginAgentPanelProps) { params.agentId.toUpperCase(); return null; }
      function contribute(client: PluginClientContext) {
        client.addWorkspacePanel({ id: "old-workspace", title: "Old", icon: "File", context: "workspace", Component: OldWorkspace });
        client.addWorkspacePanel({ id: "old-agent", title: "Old", icon: "File", context: "agent", Component: OldAgent });
        client.addWorkspacePanel({ id: "workspace", title: "Workspace", icon: "File", Component: OldWorkspace });
        client.addAgentPanel({ id: "agent", title: "Agent", icon: "File", Component: Agent });
      }
    `),
    ).toEqual([]);
  });
});
