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
  "./internal/lifecycle": "server",
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
    expect(Object.keys(server).sort()).toEqual([
      "defineAgentTool",
      "execCommand",
      "spawnProcess",
      "terminateProcess",
    ]);
  });

  it("classifies every published entry", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [...Object.keys(entries), ...compatibilityEntries].sort(),
    );
  });

  it.each(compatibilityEntries)("%s respects the client boundary", (entry) => {
    expect(
      boundaryViolations(
        path.resolve(sourceDirectory, "..", manifest.exports[entry].source),
        "client",
      ),
    ).toEqual([]);
  });

  it("typechecks a 0.12 reveal-hook consumer without exposing the hook on current UI", () => {
    expect(
      typeErrors(`
      import { useRevealedText, Icon } from "@getpaseo/plugin/client/react-native";
      import { StreamedText } from "@getpaseo/plugin/client/ui";
      // @ts-expect-error the legacy hook is not part of the current UI API
      import { useRevealedText as currentHook } from "@getpaseo/plugin/client/ui";
      import { Text } from "react-native";
      function LegacyRow({ text, phase }: { text: string; phase: "streaming" | "complete" }) {
        const revealed: string = useRevealedText(text, phase);
        return <Text>{revealed}</Text>;
      }
    `),
    ).toEqual([]);
  });

  it.each(Object.entries(entries))(
    "%s respects its %s boundary, including type dependencies",
    (specifier, runtime) => {
      const file = path.resolve(sourceDirectory, "..", manifest.exports[specifier].source);
      expect(boundaryViolations(file, runtime)).toEqual([]);
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
          entry.startsWith("./internal/") ||
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

describe("plugin agent tools SDK boundary", () => {
  it("lets a session hook attach typed tools without exposing their transport", () => {
    expect(
      typeErrors(`
      import { z } from "zod";
      import { defineAgentTool, type PluginServerContext, type AgentToolResult, type AgentToolContext, type AgentToolDefinition } from "@getpaseo/plugin/server";
      const tool: AgentToolDefinition = defineAgentTool({
        name: "create_issue",
        description: "Create an issue",
        input: z.object({ title: z.string(), count: z.string().transform(Number) }),
        async execute(input, { agent, paseo, signal }) {
          const count: number = input.count;
          // @ts-expect-error input is inferred from the schema
          input.missing;
          return { text: agent.id + input.title, structuredContent: { count } };
        },
      });
      export default function contribute(server: PluginServerContext) {
        server.addHook("agent.open.before", async ({ request }) => {
          const title: string | null = request.title;
          // @ts-expect-error labels are read-only
          request.labels.x = "changed";
          if (request.labels.x !== "y") return;
          // @ts-expect-error MCP servers use the same typed transport config as saved servers
          request.mcpServers.invalid = { type: "http", url: 42 };
          return { ...request, tools: [...request.tools, tool], mcpServers: {
            ...request.mcpServers, company: { type: "http", url: "https://tools.example.com/mcp" },
          } };
        });
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("lifecycle hook SDK types", () => {
  it("infers payloads and replacement requests and requires async handlers and new names", () => {
    expect(
      typeErrors(`
      import type { PluginServerContext, PluginHooks, PluginHookPayload, PluginHookResult } from "@getpaseo/plugin/server";
      export default function contribute(server: PluginServerContext) {
        server.addHook("worktree.create.before", async ({ request }) => {
          if (request.kind === "checkout-branch") {
            // @ts-expect-error Branch checkout has no branch-off base.
            request.baseRef;
          } else {
            const base: string = request.baseRef;
          }
          const branch: string = request.branch;
          // @ts-expect-error Repository identity is read-only.
          request.repoRoot = "/other";
          // @ts-expect-error Source checkout identity is read-only.
          request.sourceCheckout = "/other";
          if (request.kind === "checkout-change-request") {
            const number: number = request.changeRequestNumber;
          }
          return { ...request, branch: "feature", baseRef: "main", slug: "feature", path: "/work/feature" };
        });
        server.addHook("worktree.create.before", async () => {});
        server.addHook("worktree.create.after", async ({ worktree }) => {
          const path: string = worktree.path;
          const branch: string = worktree.branch;
          const source: string = worktree.sourceCheckout;
          // @ts-expect-error Worktree facts have no workspace identity.
          worktree.workspaceId;
        });
        server.addHook("workspace.create.before", async ({ request }) => ({ ...request, title: "Changed" }));
        server.addHook("workspace.create.before", async () => {});
        server.addHook("agent.open.before", async () => {});
        server.addHook("agent.turn.after", async ({ agent, outcome, timeline }, { paseo, signal }) => {
          const kind: "completed" | "failed" | "canceled" = outcome.kind;
          // @ts-expect-error Notification payloads have no creation request.
          outcome.request;
        });
        // @ts-expect-error Async handlers are required even for notifications.
        server.addHook("agent.turn.before", () => {});
        // @ts-expect-error Legacy names are only accepted by deprecated registration methods.
        server.addHook("agent.session_open", async () => {});
        // @ts-expect-error Unknown names fail typechecking.
        server.addHook("nonsense", async () => {});
        // @ts-expect-error A prepare handler must return the whole request or undefined.
        server.addHook("agent.create.before", async () => ({ invalid: true }));
        server.before("agent.session_open", ({ request }) => request);
        server.on("agent.turn_ended", () => {});
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("agent session reload SDK boundary", () => {
  it("exposes reload separately from snapshot refresh", () => {
    expect(
      typeErrors(`
      import { type PluginServerContext } from "@getpaseo/plugin/server";
      import { type PaseoAgentRefetchResult } from "@getpaseo/client";
      async function reload(server: PluginServerContext, paseo: import("@getpaseo/client").PaseoApi) {
        const agent = paseo.agents.ref("chosen-agent");
        const read: PaseoAgentRefetchResult | null = await agent.refresh("read-snapshot");
        const reopened: PaseoAgentRefetchResult | null = await agent.reload({ requestId: "reload-session" });
        await agent.reload();
        // @ts-expect-error reload options can grow without a positional signature change
        await agent.reload("reload-session");
      }
    `),
    ).toEqual([]);
  });
});
