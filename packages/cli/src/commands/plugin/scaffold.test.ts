import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPluginDirectory } from "./scaffold.js";

const directories: string[] = [];

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
  { paseo }: PluginHandlerContext,
) {
  return { configured: Boolean((await paseo.config.get()).config) };
}
`,
      ),
      writeFile(
        path.join(directory, "main.client.tsx"),
        `import React from "react";
import { Text } from "react-native";
import {
  type PluginAgentPanelProps,
  useAgent,
  usePaseo,
  useWorkspace,
} from "@getpaseo/plugin";

export function Surface() {
  const paseo = usePaseo();
  const createWorkspace = () => paseo.workspaces.create({
    source: { kind: "directory", path: "/repo" },
  });
  void createWorkspace;
  return <Text>Paseo API</Text>;
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
`,
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@getpaseo/plugin";
import { AgentPanel, Surface } from "./main.client";
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
