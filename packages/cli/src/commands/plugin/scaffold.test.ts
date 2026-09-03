import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPluginDirectory } from "./scaffold.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
const tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");

async function typecheckPlugin(directory: string): Promise<void> {
  const configPath = path.join(directory, "tsconfig.json");
  try {
    await execFileAsync(process.execPath, [tscPath, "--noEmit", "-p", configPath], {
      cwd: directory,
    });
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    throw new Error(`${failure.stdout ?? ""}${failure.stderr ?? ""}`, { cause: error });
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin scaffold", () => {
  it(
    "creates a standalone split-runtime project that typechecks",
    { timeout: 15_000 },
    async () => {
      const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
      directories.push(parent);
      const directory = path.join(parent, "hello-plugin");

      await scaffoldPluginDirectory(directory);

      const configPath = path.join(directory, "tsconfig.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        compilerOptions: { lib: string[]; types: string[] };
      };
      expect(config.compilerOptions.lib).toEqual(["ES2023"]);
      expect(config.compilerOptions.types).toEqual(["react"]);
      await expect(typecheckPlugin(directory)).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(path.join(directory, "paseo-plugin.json"), "utf8"))).toEqual(
        {
          id: "hello-plugin",
        },
      );
      const cliPackageJson = JSON.parse(
        await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))).toEqual({
        name: "hello-plugin",
        private: true,
        version: "0.0.0",
        scripts: { typecheck: "tsc --noEmit" },
        devDependencies: {
          "@getpaseo/plugin": cliPackageJson.version,
          "@tanstack/react-query": "^5.90.11",
          "@types/react": "~19.2.0",
          react: "19.1.0",
          "react-native": "0.81.5",
          typescript: "^5.9.3",
          zod: "^4.4.3",
        },
      });
      expect(await readdir(directory)).not.toContain("paseo-plugin.d.ts");
      await expect(readFile(path.join(directory, "index.client.tsx"), "utf8")).resolves.toContain(
        'from "./client/greeting"',
      );
      await expect(readFile(path.join(directory, "index.server.ts"), "utf8")).resolves.toContain(
        'from "./server/greeting"',
      );
      await expect(
        readFile(path.join(directory, "client/greeting.tsx"), "utf8"),
      ).resolves.toContain("useRpc(greetingRpc)");
      await expect(readFile(path.join(directory, "client/web.ts"), "utf8")).resolves.not.toContain(
        `/// <reference lib="dom" />`,
      );
      await expect(readFile(path.join(directory, "client/web.ts"), "utf8")).resolves.toContain(
        `declare const window: { open(url: string, target: string, features: string): unknown };`,
      );
      await expect(readFile(path.join(directory, "client/web.ts"), "utf8")).resolves.toContain(
        `Platform.OS === "web"`,
      );
      await expect(
        readFile(path.join(directory, "client/greeting.tsx"), "utf8"),
      ).resolves.toContain(`openExternal("https://paseo.sh")`);
      await expect(readFile(path.join(directory, "server/greeting.ts"), "utf8")).resolves.toContain(
        '"Hello, " + name + "!"',
      );
      await expect(readFile(path.join(directory, "shared/greeting.ts"), "utf8")).resolves.toContain(
        'name: "greeting.create"',
      );

      await writeFile(path.join(directory, "client/greeting.tsx"), '\ndocument.title = "x";\n', {
        flag: "a",
      });
      await expect(typecheckPlugin(directory)).rejects.toThrow("Cannot find name 'document'.");
    },
  );

  it("typechecks client and server Paseo API access", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
    directories.push(parent);
    const directory = path.join(parent, "paseo-api-plugin");
    await scaffoldPluginDirectory(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "shared", "inspect.ts"),
        `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const inspect = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ configured: z.boolean() }),
});
`,
      ),
      writeFile(
        path.join(directory, "server", "inspect.ts"),
        `import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { inspect } from "../shared/inspect";

export async function inspectConfig(
  _input: RpcInput<typeof inspect>,
  { paseo }: PluginHandlerContext,
) {
  return { configured: Boolean((await paseo.config.get()).config) };
}
`,
      ),
      writeFile(
        path.join(directory, "client", "main.tsx"),
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
import { inspect } from "../shared/inspect";

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
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin";
import { AgentPanel, contributeClient, Surface } from "./client/main";
import { inspect } from "./shared/inspect";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  client.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "Scan",
    context: "agent",
    Component: AgentPanel,
  });
  client.addCommandCenterItem({
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
  return contributeClient(client);
}
`,
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin";
import { inspectConfig } from "./server/inspect";
import { inspect } from "./shared/inspect";

export default function contribute(server: PluginServerContext) {
  server.handle(inspect, inspectConfig);
  return () => {};
}
`,
      ),
    ]);

    await expect(typecheckPlugin(directory)).resolves.toBeUndefined();
  }, 20_000);

  it("typechecks Forge client and server providers", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-scaffold-"));
    directories.push(parent);
    const directory = path.join(parent, "forge-plugin");
    await scaffoldPluginDirectory(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "shared", "forge-definition.ts"),
        `import type { PluginForgeDefinition } from "@getpaseo/plugin";

export const forgeDefinition = {
  id: "example",
  displayName: "Example Forge",
  changeRequestAbbrev: "MR",
  changeRequestNoun: "merge request",
  changeRequestNumberPrefix: "!",
  issueNumberPrefix: "#",
  signIn: null,
  cloudHosts: ["forge.example.com"],
} satisfies PluginForgeDefinition;
`,
      ),
      writeFile(
        path.join(directory, "shared", "forge-module-boundaries.ts"),
        `import type {
  PluginForgeClientProviderContribution,
  PluginForgeClientView,
  PluginForgeFactsRegistration,
  PluginForgeSignInCommand,
} from "@getpaseo/plugin";
import type {
  PluginForgeDefinition,
  PluginForgeServerService,
} from "@getpaseo/plugin/server";

// @ts-expect-error Client Forge presentation types are exported from the root module.
import type { PluginForgeClientView as InvalidClientView } from "@getpaseo/plugin/server";
// @ts-expect-error Server Forge service types are exported from the server module.
import type { PluginForgeServerService as InvalidServerService } from "@getpaseo/plugin";
// @ts-expect-error Legacy search-kind aliases are internal compatibility details.
import type { ForgeSearchRequestKind } from "@getpaseo/plugin/server";

export type ForgeModuleBoundarySmoke = [
  PluginForgeClientProviderContribution,
  PluginForgeClientView,
  PluginForgeFactsRegistration,
  PluginForgeSignInCommand,
  PluginForgeDefinition,
  PluginForgeServerService,
];
`,
      ),
      writeFile(
        path.join(directory, "client", "forge.ts"),
        `import {
  defineForgeClientProvider,
  defineForgeFacts,
  type PluginForgeMergeCapability,
} from "@getpaseo/plugin";
import { z } from "zod";
import { forgeDefinition } from "../shared/forge-definition";

const factsSchema = z.object({
  forge: z.literal("example"),
  ready: z.boolean(),
});

const mergeCapability: PluginForgeMergeCapability = {
  directMergeReady: true,
  canEnableAutoMerge: false,
  autoMergeEnabled: false,
  canDisableAutoMerge: false,
  mergeBlockedByQueue: false,
  allowedMethods: ["merge"],
  preferredMethod: "merge",
};

export const forgeClientProvider = defineForgeClientProvider({
  definition: forgeDefinition,
  facts: defineForgeFacts({
    family: "example",
    schema: factsSchema,
    deriveMergeCapability: ({ ready }) => ({
      ...mergeCapability,
      directMergeReady: ready,
    }),
  }),
  urlGrammar: {
    treeInfix: "/tree/",
    blobInfix: "/blob/",
    lineAnchorStyle: "gitlab",
  },
  view: {
    icon: {
      kind: "svg-path",
      viewBox: [0, 0, 24, 24] as const,
      path: "M4 4h16v16H4z",
    },
    brandColor: { light: "#123456", dark: "#abcdef" },
  },
});
`,
      ),
      writeFile(
        path.join(directory, "server", "forge.ts"),
        `import {
  createUnavailableSearchResult,
  defineForgeServerProvider,
  type PluginForgeServerService,
  type PullRequestCheck,
  type PullRequestSummary,
} from "@getpaseo/plugin/server";
import { forgeDefinition } from "../shared/forge-definition";

const manualCheck: PullRequestCheck = {
  name: "Deploy approval",
  status: "skipped",
  url: null,
  traits: ["manual", "future-forge-trait"],
};

function pullRequest(number: number): PullRequestSummary {
  return {
    number,
    title: "Example change",
    url: \`https://forge.example.com/project/merge_requests/\${number}\`,
    state: "opened",
    body: null,
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    updatedAt: new Date(0).toISOString(),
  };
}

const service: PluginForgeServerService = {
  async listPullRequests() {
    return [pullRequest(1)];
  },
  async listIssues() {
    return [];
  },
  async getPullRequest({ number }) {
    return pullRequest(number);
  },
  async getPullRequestHeadRef() {
    return "feature";
  },
  async getPullRequestCheckoutTarget({ number }) {
    return {
      number,
      baseRefName: "main",
      headRefName: "feature",
      checkoutRefs: [{ remoteRef: "refs/merge-requests/1/head" }],
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    };
  },
  defaultCheckoutRefs({ changeRequestNumber }) {
    return [{ remoteRef: \`refs/merge-requests/\${changeRequestNumber}/head\` }];
  },
  buildPrLocalBranchName({ checkoutTarget }) {
    return \`mr-\${checkoutTarget.number}\`;
  },
  async getCurrentPullRequestStatus() {
    return {
      url: "https://forge.example.com/project/merge_requests/1",
      title: "Example change",
      state: "opened",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      mergeable: "UNKNOWN",
      checks: [manualCheck],
      checksStatus: "success",
      reviewDecision: null,
    };
  },
  async getPullRequestTimeline({ prNumber, repoOwner, repoName }) {
    return {
      prNumber,
      repoOwner,
      repoName,
      items: [],
      truncated: false,
      error: null,
    };
  },
  async getCheckDetails({ checkRunId }) {
    return {
      checkRunId: checkRunId ?? 0,
      name: "Example check",
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
  },
  async searchIssuesAndPrs() {
    return createUnavailableSearchResult("unauthenticated");
  },
  async createPullRequest() {
    return { url: "https://forge.example.com/project/merge_requests/1", number: 1 };
  },
  async mergePullRequest() {
    return { success: true };
  },
  async enablePullRequestAutoMerge() {
    return { success: true };
  },
  async disablePullRequestAutoMerge() {
    return { success: true };
  },
  async isAuthenticated() {
    return false;
  },
  invalidate() {},
};

export const forgeServerProvider = defineForgeServerProvider({
  definition: forgeDefinition,
  service,
  probeHost: (host) => host === "forge.example.com",
});
`,
      ),
      writeFile(
        path.join(directory, "index.client.ts"),
        `import type { PluginClientContext } from "@getpaseo/plugin";
import { forgeClientProvider } from "./client/forge";

export default function contribute(client: PluginClientContext) {
  client.addForgeClientProvider(forgeClientProvider);
  return () => {};
}
`,
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin";
import { forgeServerProvider } from "./server/forge";

export default function contribute(server: PluginServerContext) {
  server.addForgeServerProvider(forgeServerProvider);
  return () => {};
}
`,
      ),
    ]);

    await expect(typecheckPlugin(directory)).resolves.toBeUndefined();
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
