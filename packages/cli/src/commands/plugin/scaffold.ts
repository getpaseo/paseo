import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginIdSchema } from "@getpaseo/protocol/messages";

const SDK_DECLARATIONS = `declare module "@getpaseo/plugin/server" {
  import type { PaseoApi } from "@getpaseo/client";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  export interface PluginAttachmentItem {
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  }

  export interface PluginAttachmentSearchPayload {
    items: PluginAttachmentItem[];
  }

  export interface PluginAttachmentSourceContribution {
    id: string;
    title: string;
    icon: string;
    pickerTitle: string;
    searchPlaceholder: string;
    search: PluginRpcContract;
  }

  export interface PluginHandlerContext {
    paseo: PaseoApi;
  }

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

  export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
    definition: Definition,
  ): Definition;

  export const PluginAttachmentItemSchema: import("zod").ZodType<PluginAttachmentItem>;
  export const PluginAttachmentSearchPayloadSchema: import("zod").ZodType<PluginAttachmentSearchPayload>;
}

declare module "@getpaseo/plugin" {
  import type { ComponentType } from "react";
  import type { PaseoApi } from "@getpaseo/client";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
  import type {
    PluginAttachmentSourceContribution,
    PluginHandlerContext,
    PluginRpcContract,
  } from "@getpaseo/plugin/server";

  export {
    PluginAttachmentItemSchema,
    PluginAttachmentSearchPayloadSchema,
    defineAttachmentSource,
    defineRpc,
    type PluginAttachmentItem,
    type PluginAttachmentSearchPayload,
    type PluginAttachmentSourceContribution,
    type PluginHandlerContext,
    type PluginRpcContract,
  } from "@getpaseo/plugin/server";

  export interface PluginTheme {
    readonly colors: {
      readonly surface0: string;
      readonly foreground: string;
      readonly foregroundMuted: string;
      readonly accent: string;
      readonly accentForeground: string;
      readonly statusDanger: string;
    };
  }

  export interface PluginHostProps {
    theme: PluginTheme;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  export interface PluginSurfaceProps extends PluginHostProps {}

  export interface PluginWorkspaceSnapshot {
    readonly id: string;
    readonly projectId: string;
    readonly projectDisplayName: string;
    readonly projectRootPath: string;
    readonly directory: string;
    readonly projectKind: "git" | "non_git" | "directory";
    readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
    readonly name: string;
    readonly title: string | null;
    readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
    readonly statusEnteredAt: string | null;
    readonly archivingAt: string | null;
    readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  }

  export interface PluginAgentSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly provider: string;
    readonly status: "initializing" | "idle" | "running" | "error" | "closed";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly model: string | null;
    readonly currentModeId: string | null;
    readonly thinkingOptionId: string | null;
    readonly requiresAttention: boolean;
    readonly attentionReason: "finished" | "error" | "permission" | null;
    readonly parentAgentId: string | null;
    readonly labels: Readonly<Record<string, string>>;
  }

  export interface PluginWorkspacePanelProps extends PluginHostProps {
    context: "workspace";
    workspaceId: string;
  }

  export interface PluginAgentPanelProps extends PluginHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
  }

  export type PluginWorkspacePanelContribution =
    | { id: string; title: string; icon: string; context: "workspace"; Component: ComponentType<PluginWorkspacePanelProps> }
    | { id: string; title: string; icon: string; context: "agent"; Component: ComponentType<PluginAgentPanelProps> };

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    icon: string;
    surface: string;
  }

  export interface PluginThemeColors {
    background: string;
    foreground: string;
    raised: string;
    control: string;
    accent: string;
    highlight?: string;
    mutedForeground: string;
    ring: string;
  }

  export interface PluginThemeContribution {
    id: string;
    name: string;
    appearance: "dark";
    colors: PluginThemeColors;
  }

  export interface PluginSurfaceContribution {
    id: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginCommandCapabilities {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    openSurface(id: string): void;
  }

  export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
    context: "global";
  }

  export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
    context: "workspace";
    workspace: PluginWorkspaceSnapshot;
    openPanel(id: string): void;
  }

  export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string): void;
  }

  export type PluginCommandCenterItemContribution =
    | { id: string; title: string; icon: string; keywords?: readonly string[]; context: "global"; onSelect(context: PluginGlobalCommandContext): void | Promise<void> }
    | { id: string; title: string; icon: string; keywords?: readonly string[]; context: "workspace"; onSelect(context: PluginWorkspaceCommandContext): void | Promise<void> }
    | { id: string; title: string; icon: string; keywords?: readonly string[]; context: "agent"; onSelect(context: PluginAgentCommandContext): void | Promise<void> };

  export interface PluginContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
    addSidebarItem(contribution: PluginSidebarContribution): void;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
    addTheme(contribution: PluginThemeContribution): void;
  }

  export type PluginCleanup = () => void | Promise<void>;
  export type PluginContribution = (plugin: PluginContext) => PluginCleanup;

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  export function usePaseo(): PaseoApi;

  export function useWorkspace<Selection>(
    workspaceId: string,
    selector: (workspace: PluginWorkspaceSnapshot) => Selection,
  ): Selection | null;

  export function useAgent<Selection>(
    agentId: string,
    selector: (agent: PluginAgentSnapshot) => Selection,
  ): Selection | null;
}
`;

const TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2023", "DOM"],
    jsx: "react-jsx",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
  },
  include: ["**/*.ts", "**/*.tsx"],
};

const ENTRY = `import type { PluginContext } from "@getpaseo/plugin";
import { MainSurface } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", MainSurface);
  return () => {};
}
`;

const CLIENT_SURFACE = `import type { PluginSurfaceProps } from "@getpaseo/plugin";
import React, { useMemo } from "react";
import { Text, View } from "react-native";

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      text: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.text}>Hello from my plugin</Text>
    </View>
  );
}
`;

export interface PluginScaffold {
  id: string;
  directory: string;
}

export async function scaffoldPluginDirectory(
  targetDirectory: string,
  requestedId?: string,
): Promise<PluginScaffold> {
  const directory = path.resolve(targetDirectory);
  const id = PluginIdSchema.parse(requestedId ?? path.basename(directory));
  await mkdir(directory, { recursive: true });
  const existing = await readdir(directory);
  if (existing.length > 0) {
    throw new Error(`Plugin directory must be empty: ${directory}`);
  }

  const packageJson = {
    name: id,
    private: true,
    version: "0.0.0",
    scripts: { typecheck: "tsc --noEmit" },
    devDependencies: {
      "@getpaseo/client": "^0.4.0",
      "@tanstack/react-query": "^5.90.11",
      "@types/react": "~19.2.0",
      react: "19.1.0",
      "react-native": "0.81.5",
      typescript: "^5.9.3",
      zod: "^4.4.3",
    },
  };
  const files = new Map<string, string>([
    ["paseo-plugin.json", `${JSON.stringify({ id }, null, 2)}\n`],
    ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(TSCONFIG, null, 2)}\n`],
    ["paseo-plugin.d.ts", SDK_DECLARATIONS],
    ["index.ts", ENTRY],
    ["main.client.tsx", CLIENT_SURFACE],
  ]);
  await Promise.all(
    [...files].map(([filename, contents]) =>
      writeFile(path.join(directory, filename), contents, { flag: "wx" }),
    ),
  );
  return { id, directory };
}
