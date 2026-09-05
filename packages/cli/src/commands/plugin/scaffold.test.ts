import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPluginDirectory } from "./scaffold.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin scaffold", () => {
  it("creates a standalone split-runtime project that typechecks", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
    directories.push(parent);
    const directory = path.join(parent, "hello-plugin");

    await scaffoldPluginDirectory(directory);

    const configPath = path.join(directory, "tsconfig.json");
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(loaded.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
    expect(JSON.parse(await readFile(path.join(directory, "paseo-plugin.json"), "utf8"))).toEqual({
      id: "hello-plugin",
    });
    await expect(readFile(path.join(directory, "index.ts"), "utf8")).resolves.toContain(
      'from "./main.client"',
    );
    await expect(readFile(path.join(directory, "main.client.tsx"), "utf8")).resolves.toContain(
      "Hello from my plugin",
    );
    await expect(readFile(path.join(directory, "paseo-plugin.d.ts"), "utf8")).resolves.toContain(
      "readonly signal: AbortSignal;",
    );
    await expect(readFile(path.join(directory, "tool.server.ts"), "utf8")).resolves.toContain(
      "defineTool",
    );
  });

  it("typechecks client and server Paseo API access", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
    directories.push(parent);
    const directory = path.join(parent, "paseo-api-plugin");
    await scaffoldPluginDirectory(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "inspect.shared.ts"),
        `import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const inspect = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ configured: z.boolean() }),
});
`,
      ),
      writeFile(
        path.join(directory, "inspect.server.ts"),
        `import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { output as ZodOutput } from "zod";
import { inspect } from "./inspect.shared";

export async function inspectConfig(
  _input: ZodOutput<typeof inspect.input>,
  { paseo, signal }: PluginHandlerContext,
) {
  signal.addEventListener("abort", () => undefined);
  return { configured: Boolean((await paseo.config.get()).config) };
}
`,
      ),
      writeFile(
        path.join(directory, "main.client.tsx"),
        `import React from "react";
import { Text } from "react-native";
import { Icon, Modal, useToast } from "@getpaseo/plugin/react-native";
import {
  type PluginAgentPanelProps,
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginSurfaceProps,
  useAgent,
  usePaseo,
  useWorkspace,
} from "@getpaseo/plugin";
import { inspect } from "./inspect.shared";

export function Surface({ navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const createWorkspace = () => paseo.workspaces.create({
    source: { kind: "directory", path: "/repo" },
  });
  navigation?.openAgent({ agentId: "agent-1" });
  navigation?.openWorkspace({ workspaceId: "workspace-1" });
  void createWorkspace;
  return <><Icon name="Settings" size={18} color="#123456" /><Text onPress={() => toast.show("Ready")}>Paseo API</Text><Modal title="Example" icon={<Icon name="Settings" />} open={false} onOpenChange={() => {}}><Modal.Content><Text>Modal</Text></Modal.Content></Modal></>;
}

export function AgentPanel({ workspaceId, agentId }: PluginAgentPanelProps) {
  const workspaceName = useWorkspace(workspaceId, (workspace) => {
    // @ts-expect-error Plugin snapshots are readonly.
    workspace.name = "mutated";
    return workspace.name;
  });
  const agentTitle = useAgent(agentId, (agent) => {
    // @ts-expect-error Nested plugin snapshot values are readonly.
    agent.labels.phase = "mutated";
    return agent.title;
  });
  return <Text>{workspaceName}: {agentTitle}</Text>;
}

export function ComposerPill({ workspaceId, agentId }: PluginComposerPillProps) {
  return <Text>{workspaceId}: {agentId}</Text>;
}

export function contributeClient(client: PluginClientContext) {
  return client.addComposerPill({
    id: "open-review",
    title: "Open review",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    Component: ComposerPill,
    async onPress() {
      await client.rpc(inspect, {});
      client.openPanel("review", { workspaceId: "workspace-a", agentId: "agent-a" });
    },
  });
}
`,
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@getpaseo/plugin";
import { AgentPanel, contributeClient, Surface } from "./main.client";
import { inspectConfig } from "./inspect.server";
import { inspect } from "./inspect.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspect, inspectConfig);
  plugin.addSurface("main", Surface);
  plugin.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "Scan",
    context: "agent",
    Component: AgentPanel,
  });
  plugin.addCommandCenterItem({
    id: "open-review",
    title: "Open review",
    icon: "Scan",
    context: "agent",
    async onSelect({ paseo, rpc, workspace, openPanel }) {
      await paseo.workspaces.ref(workspace.id).setTitle("Review");
      await rpc(inspect, {});
      openPanel("review");
    },
  });
  plugin.addClientSide(contributeClient);
  return () => {};
}
`,
      ),
    ]);

    const configPath = path.join(directory, "tsconfig.json");
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );

    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
  }, 20_000);

  it("typechecks after installing the scaffold outside the workspace", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-plugin-external-"));
    directories.push(parent);
    const directory = path.join(parent, "external-plugin");
    await scaffoldPluginDirectory(directory);
    const generatedPackage = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(generatedPackage.devDependencies).toMatchObject({
      "@getpaseo/client": "0.8.0-beta.1",
      "@getpaseo/plugin": "0.8.0-beta.1",
      "@getpaseo/protocol": "0.8.0-beta.1",
    });
    await execFileAsync(
      "npm",
      ["pack", "--workspace=@getpaseo/protocol", `--pack-destination=${parent}`],
      { cwd: process.cwd(), timeout: 120_000 },
    );
    await execFileAsync(
      "npm",
      ["pack", "--workspace=@getpaseo/client", `--pack-destination=${parent}`],
      { cwd: process.cwd(), timeout: 120_000 },
    );
    await execFileAsync(
      "npm",
      ["pack", "--workspace=@getpaseo/plugin", `--pack-destination=${parent}`],
      { cwd: process.cwd(), timeout: 120_000 },
    );
    await execFileAsync(
      "npm",
      ["pack", "--workspace=@getpaseo/relay", `--pack-destination=${parent}`],
      { cwd: process.cwd(), timeout: 120_000 },
    );
    const tarballs = await readdir(parent);
    const protocolTarball = tarballs.find((entry) => entry.startsWith("getpaseo-protocol-"));
    const clientTarball = tarballs.find((entry) => entry.startsWith("getpaseo-client-"));
    const pluginTarball = tarballs.find((entry) => entry.startsWith("getpaseo-plugin-"));
    const relayTarball = tarballs.find((entry) => entry.startsWith("getpaseo-relay-"));
    if (!protocolTarball || !clientTarball || !pluginTarball || !relayTarball) {
      throw new Error("Local SDK tarballs were not created");
    }
    const packagePath = path.join(directory, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    packageJson.devDependencies["@getpaseo/client"] =
      `file:${path.relative(directory, path.join(parent, clientTarball))}`;
    packageJson.devDependencies["@getpaseo/plugin"] =
      `file:${path.relative(directory, path.join(parent, pluginTarball))}`;
    packageJson.devDependencies["@getpaseo/protocol"] =
      `file:${path.relative(directory, path.join(parent, protocolTarball))}`;
    packageJson.devDependencies["@getpaseo/relay"] =
      `file:${path.relative(directory, path.join(parent, relayTarball))}`;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await execFileAsync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
      { cwd: directory, timeout: 120_000 },
    );
    await execFileAsync("npm", ["run", "typecheck"], { cwd: directory, timeout: 120_000 });
  }, 180_000);

  it("refuses to write into a non-empty directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-scaffold-"));
    directories.push(directory);
    await writeFile(path.join(directory, "notes.txt"), "keep me");

    await expect(scaffoldPluginDirectory(directory, "hello-plugin")).rejects.toThrow(
      "Plugin directory must be empty",
    );
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("keep me");
  });
});
