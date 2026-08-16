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
  it("creates a standalone strict TSX project that typechecks", async () => {
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
  });

  it("typechecks client and server Paseo API access", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
    directories.push(parent);
    const directory = path.join(parent, "paseo-api-plugin");
    await scaffoldPluginDirectory(directory);
    await writeFile(
      path.join(directory, "index.tsx"),
      `import React from "react";
import { Text } from "react-native";
import { z } from "zod";
import { defineRpc, type PluginContext, usePaseo } from "@paseo/plugin";

const inspect = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ configured: z.boolean() }),
});

function Surface() {
  const paseo = usePaseo();
  const createWorkspace = () => paseo.workspaces.create({
    source: { kind: "directory", path: "/repo" },
  });
  void createWorkspace;
  return <Text>Paseo API</Text>;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspect, async (_input, { paseo }) => ({
    configured: Boolean((await paseo.config.get()).config),
  }));
  plugin.addSurface("main", Surface);
  return () => undefined;
}
`,
    );

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
