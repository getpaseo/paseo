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

describe("plugin composer SDK boundary", () => {
  it("lets a composer item read and change the composer through typed commands and controls", () => {
    expect(
      typeErrors(`
      import { useComposer, type PluginClientContext } from "@getpaseo/plugin/client";
      import { Action, Select, Toggle } from "@getpaseo/plugin/client/ui";
      function Item() {
        const composer = useComposer();
        const context: "agent" | "draft" | "new-workspace" = composer.context;
        const provider: string | null = composer.agent.provider;
        const flag: boolean = composer.agent.metadata.flag === true;
        // @ts-expect-error reads are not writable
        composer.agent.model = "other";
        composer.setProvider("codex").then(() => composer.setModel("gpt"));
        composer.setOptions({ effort: null });
        composer.setMetadata({ flag: true, stale: null });
        composer.insertText("text");
        composer.focus({ selection: { start: 0, end: composer.prompt.length } }).then(() => composer.focus());
        composer.addAttachment({ sourceId: "issues", item: { id: "1", identifier: "1", title: "t", url: "https://e.com", text: "t", resourceType: "issue" } });
        // @ts-expect-error commands take JSON values
        composer.setMetadata({ fn: () => {} });
        return (
          <>
            <Toggle title="Flag" icon="Flag" value={flag} onValueChange={({ value }: { value: boolean }) => composer.setMetadata({ flag: value })} />
            <Select title="Size" icon="Gauge" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onValueChange={({ value }: { value: "a" | "b" }) => {}} />
            <Action title="Insert" icon="Plus" onPress={() => composer.setPrompt("")} />
          </>
        );
      }
      export default function contribute(client: PluginClientContext) {
        client.addComposerItem({ id: "item", Component: Item });
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("plugin composers by reference SDK boundary", () => {
  it("reaches a running agent's composer from any component and from every command context", () => {
    expect(
      typeErrors(`
      import { useComposers, type PluginClientContext } from "@getpaseo/plugin/client";
      function Button() {
        const [focused] = useComposers({ focused: true });
        const byId = useComposers({ agentId: "agent-1" });
        if (!focused) return null;
        const first: string = byId[0]?.prompt ?? "";
        focused.insertText("text");
        focused.setMetadata({ flag: true });
        // @ts-expect-error a selector names an agent or the focused agent
        useComposers({ active: true });
        // @ts-expect-error focused is true or absent
        useComposers({ focused: false });
        return null;
      }
      export default function contribute(client: PluginClientContext) {
        client.addWorkspacePanel({ id: "panel", title: "P", icon: "File", context: "workspace", Component: Button });
        client.addCommandCenterItem({
          id: "mark",
          title: "Mark",
          icon: "Flag",
          context: "agent",
          async onSelect(context) {
            for (const composer of context.composers({ agentId: context.agent.id })) {
              await composer.setMetadata({ review: true });
            }
          },
        });
        client.addCommandCenterItem({
          id: "global",
          title: "Global",
          icon: "Flag",
          context: "global",
          onSelect: ({ composers }) => composers({ focused: true })[0]?.insertText("x"),
        });
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("plugin New workspace SDK boundary", () => {
  it("lets a New workspace item read the setup and change it through typed commands and a Combobox", () => {
    expect(
      typeErrors(`
      import { useNewWorkspace, type PluginClientContext } from "@getpaseo/plugin/client";
      import { Combobox } from "@getpaseo/plugin/client/ui";
      interface Issue { id: string; label: string; branch: string }
      function Item() {
        const newWorkspace = useNewWorkspace();
        const isolation: "local" | "worktree" = newWorkspace.isolation;
        const branch: string | null = newWorkspace.branch;
        const project: string | undefined = newWorkspace.project?.name;
        const host: string = newWorkspace.host.label;
        const base = newWorkspace.baseRef;
        if (base?.type === "branch") { const name: string = base.name; }
        // @ts-expect-error project is read-only
        newWorkspace.project = null;
        // @ts-expect-error host is read-only
        newWorkspace.setHost("other");
        // @ts-expect-error metadata reads are not writable
        newWorkspace.metadata.key = "x";
        newWorkspace.setIsolation("worktree").then(() => newWorkspace.setBaseRef({ type: "branch", name: "main" }));
        newWorkspace.setBranch(null);
        newWorkspace.setMetadata({ issue: "1", stale: null });
        // @ts-expect-error commands take JSON values
        newWorkspace.setMetadata({ fn: () => {} });
        return (
          <Combobox<Issue>
            title="Issue"
            icon="CircleDot"
            value={{ id: "1", label: "One" }}
            search={async ({ query }: { query: string }) => [{ id: query, label: query, branch: "b" }]}
            onSelect={({ item }) => newWorkspace.setBranch(item.branch)}
          />
        );
      }
      export default function contribute(client: PluginClientContext) {
        client.addNewWorkspaceItem({ id: "item", Component: Item });
        return () => {};
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
        server.addHook("agent.open.before", async ({ request }) => {
          const background: boolean = request.background;
          if (background) return;
          // A hook written before background and metadata returns its own object without them.
          return {
            agentId: request.agentId, workspaceId: request.workspaceId, provider: request.provider,
            cwd: request.cwd, reason: request.reason, purpose: request.purpose, title: request.title,
            labels: request.labels, tools: request.tools, env: request.env,
            mcpServers: request.mcpServers,
          };
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
      import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
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
        server.addHook("agent.open.before", async ({ request }) => {
          const { metadata, ...withoutMetadata } = request;
          return withoutMetadata;
        });
        server.addHook("agent.turn.after", async (event, { paseo, signal }) => {
          const { agent, outcome } = event;
          const kind: "completed" | "failed" | "canceled" = outcome.kind;
          // @ts-expect-error Turn payloads carry no history; read it from the agent's timeline.
          event.timeline;
          const turn = await paseo.agents
            .ref(agent.id)
            .timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
          const items: readonly AgentTimelineItem[] = turn.entries
            .filter((entry) => entry.turnId === event.turnId)
            .map(({ item }) => item);
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
        server.before("agent.session_open", ({ request }) => ({
          agentId: request.agentId, workspaceId: request.workspaceId, provider: request.provider,
          cwd: request.cwd, reason: request.reason, purpose: request.purpose, title: request.title,
          labels: request.labels, metadata: request.metadata, tools: request.tools, env: request.env,
          mcpServers: request.mcpServers,
        }));
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

describe("plugin subscription SDK boundary", () => {
  it("types contracts, overloaded handlers, the client hook, and the client entry handle", () => {
    expect(
      typeErrors(`
      import { defineRpc, defineSubscription, type SubscriptionEvent, type SubscriptionInput } from "@getpaseo/plugin";
      import type { PluginClientContext } from "@getpaseo/plugin/client";
      import { useRpc, useSubscription } from "@getpaseo/plugin/client";
      import type { PluginServerContext, PluginSubscriptionContext } from "@getpaseo/plugin/server";
      import { z } from "zod";
      const diffWatch = defineSubscription({
        name: "diff.watch",
        input: z.object({ a: z.string(), b: z.string() }),
        event: z.object({ path: z.string(), status: z.enum(["added", "modified", "deleted"]) }),
      });
      const frames = defineSubscription({
        name: "screen.capture",
        input: z.object({ display: z.number() }),
        event: z.union([z.instanceof(Uint8Array), z.object({ type: z.literal("resized"), width: z.number() })]),
      });
      const thumbnail = defineRpc({ name: "thumbnail.render", input: z.object({ path: z.string() }), output: z.instanceof(Uint8Array) });
      const input: SubscriptionInput<typeof diffWatch> = { a: "main", b: "HEAD" };
      const event: SubscriptionEvent<typeof diffWatch> = { path: "a.ts", status: "added" };
      function server(server: PluginServerContext) {
        server.handle(diffWatch, ({ a, b }, { push, signal, paseo }: PluginSubscriptionContext<SubscriptionEvent<typeof diffWatch>>) => {
          const pushed: Promise<void> = push({ path: a + b, status: "modified" });
          // @ts-expect-error events follow the contract
          void push({ path: 1, status: "modified" });
          signal.addEventListener("abort", () => undefined, { once: true });
        });
        server.handle(frames, async (_input, { push }) => {
          await push(new Uint8Array(4));
          await push({ type: "resized", width: 2 });
        });
        server.handle(thumbnail, ({ path }) => new Uint8Array(path.length));
        // @ts-expect-error subscription handlers receive push, not an output
        server.handle(diffWatch, () => ({ path: "a", status: "added" as const }) as unknown as number);
      }
      function Panel() {
        const state = useSubscription(diffWatch, { a: "main", b: "HEAD" }, (change) => {
          const status: "added" | "modified" | "deleted" = change.status;
        });
        if (state.status === "error") state.error.message;
        // @ts-expect-error the hook has no ready state, only live
        if (state.status === "ready") return null;
        useSubscription(frames, { display: 1 }, (event) => {
          if (event instanceof Uint8Array) event.byteLength;
          else event.width;
        });
        const render = useRpc(thumbnail);
        void render({ path: "x" }).then((png: Uint8Array) => png.byteLength);
        return null;
      }
      function client(client: PluginClientContext) {
        const controller = new AbortController();
        const remover = client.subscribe(diffWatch, { a: "main", b: "HEAD" }, (change) => change.path, { signal: controller.signal });
        const ready: Promise<void> = remover.ready;
        const released: Promise<void> = remover.release();
        remover();
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("sidebar data SDK boundary", () => {
  it("accepts references and preserves string-id panel consumers", () => {
    expect(
      typeErrors(`
      import { useWorkspace, useAgent, usePaseo, type PluginClientContext, type PluginSidebarViewProps, type WorkspaceRef, type AgentRef, useProject, useTerminal, useWorkspaces, useAgents, useProjects, useTerminals, type ProjectRef, type TerminalRef, type Query, type Group } from "@getpaseo/plugin/client";
      import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
      function Panel({ workspace, agent }: { workspace: WorkspaceRef; agent: AgentRef }) {
        const snapshot: PluginWorkspaceSnapshot | null = useWorkspace(workspace);
        const title: string | null = useWorkspace("workspace", item => item.name);
        const status = useAgent(agent, item => ({ status: item.status }), (a, b) => a?.status === b?.status);
        const agentSnapshot = useAgent(agent);
        const custom = useWorkspace(workspace, undefined, (a, b) => a?.name === b?.name);
        const workspaces: readonly WorkspaceRef[] = useWorkspaces({ orderBy: "name" });
        const groups: readonly Group<AgentRef>[] = useAgents({ groupBy: item => item.status });
        const projects: readonly ProjectRef[] = useProjects({ hosts: [workspace.hostId] });
        const terminals: readonly TerminalRef[] = useTerminals();
        const paseo = usePaseo();
        void paseo.workspaces.ref(workspace).setPinned(true);
        void paseo.workspaces.ref(workspace).setLabel("Later", { assigned: true });
        void paseo.workspaces.ref("old-id").setTitle("Title");
        if (projects[0]) { paseo.projects.ref(projects[0]).open(); void paseo.projects.ref(projects[0]).createWorkspace(); }
        if (terminals[0]) { paseo.terminals.ref(terminals[0]).focus(); void paseo.terminals.ref(terminals[0]).kill(); }
        void paseo.agents.ref(agent);
        if (projects[0]) useProject(projects[0], item => item.displayName);
        if (terminals[0]) useTerminal(terminals[0]);
        function View(props: PluginSidebarViewProps) {
          props.navigation.openWorkspace(workspace);
          props.navigation.openAgent(agent);
          props.dismiss();
          return null;
        }
        function contribute(client: PluginClientContext) {
          client.addSidebarView({ id: "workspaces", title: "Workspaces", Component: View });
        }
        const query: Query<PluginWorkspaceSnapshot> = { hosts: [workspace.hostId], orderBy: ["name", "desc"] };
        return null;
      }
    `),
    ).toEqual([]);
  });
});
