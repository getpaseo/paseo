import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  PluginCodeBlockActionsProps,
  PluginCodeBlockActionsContribution,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { getMarkdownFenceLanguage } from "@/components/markdown/fence/language";
import { useInstalledPlugins } from "./registry";
import type { InstalledPlugin } from "./types";
import { PluginInstallationProvider } from "./installation-provider";
import { createPluginClientStateSource } from "./client-state/source";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { usePluginHostNavigation } from "./host-navigation";
import { resolvePluginPlatform } from "./platform";
import { toPluginTheme } from "./theme";

interface BlockContext {
  serverId: string;
  agentId: string;
  messageId: string;
  fenceOffset: number;
  phase: "streaming" | "complete";
}

const CodeBlockActionsContext = createContext<BlockContext | null>(null);

export function CodeBlockActionsProvider({
  serverId,
  agentId,
  messageId,
  fenceOffset,
  phase,
  children,
}: {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  fenceOffset: number;
  phase: BlockContext["phase"];
  children: ReactNode;
}) {
  const value = useMemo(() => {
    if (!serverId || !agentId || !messageId) return null;
    return { serverId, agentId, messageId, fenceOffset, phase };
  }, [serverId, agentId, messageId, fenceOffset, phase]);
  return (
    <CodeBlockActionsContext.Provider value={value}>{children}</CodeBlockActionsContext.Provider>
  );
}

function ActionSurface({
  plugin,
  contribution,
  block,
  theme,
}: {
  plugin: InstalledPlugin;
  contribution: PluginCodeBlockActionsContribution;
  block: Pick<
    PluginCodeBlockActionsProps,
    "agentId" | "messageId" | "blockIndex" | "code" | "language" | "phase"
  >;
  theme: PluginTheme;
}) {
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const navigation = usePluginHostNavigation(plugin.serverId);
  const stateSource = useMemo(
    () => createPluginClientStateSource(plugin.serverId),
    [plugin.serverId],
  );
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const host = useMemo(
    () => ({ id: plugin.serverId, label: hostLabel }),
    [plugin.serverId, hostLabel],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component {...block} host={host} theme={theme} layout={layout} navigation={navigation} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedActionSurface = withUnistyles(ActionSurface);
const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginCodeBlockActions({
  code,
  info,
  localIndex,
}: {
  code: string;
  info: string | null | undefined;
  localIndex: number;
}) {
  const context = useContext(CodeBlockActionsContext);
  const plugins = useInstalledPlugins();
  const language = getMarkdownFenceLanguage(info);
  const block = useMemo(() => {
    if (!context || !language || !Number.isInteger(localIndex) || localIndex < 0) return null;
    return {
      agentId: context.agentId,
      messageId: context.messageId,
      blockIndex: context.fenceOffset + localIndex,
      code,
      language,
      phase: context.phase,
    };
  }, [context, language, localIndex, code]);
  if (!context || !block) return null;
  return plugins
    .filter((plugin) => plugin.serverId === context.serverId)
    .flatMap((plugin) =>
      plugin.codeBlockActions
        .filter((action) => action.languages.includes(block.language))
        .map((contribution) => (
          <ThemedActionSurface
            key={`${plugin.id}/${contribution.id}`}
            plugin={plugin}
            contribution={contribution}
            block={block}
            uniProps={pluginThemeMapping}
          />
        )),
    );
}
