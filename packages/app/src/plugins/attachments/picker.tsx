import { useCallback, useMemo, useState, type ReactElement, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginAttachmentItem, PluginSerializableIcon } from "@getpaseo/plugin";
import type { PluginAttachmentSourceContribution } from "../types";
import { searchPluginAttachments } from "@getpaseo/plugin/client/host";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useFetchQuery } from "@/data/query";
import { useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { PluginIconView } from "../icons";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { createPluginResourceAttachment, togglePluginResourceAttachment } from "./model";

const SEARCH_STALE_TIME_MS = 30_000;
const EMPTY_ATTACHMENT_ITEMS: PluginAttachmentItem[] = [];
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function SourceIcon({ icon, color = "" }: { icon: PluginSerializableIcon; color?: string }) {
  return <PluginIconView icon={icon} size={ICON_SIZE.md} color={color} />;
}

const ThemedSourceIcon = withUnistyles(SourceIcon);

interface InstalledAttachmentSource {
  plugin: InstalledPlugin;
  source: PluginAttachmentSourceContribution;
  key: string;
}

interface PluginAttachmentPickerInput {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  attachments: UserComposerAttachment[];
  onChangeAttachments: (attachments: UserComposerAttachment[]) => void;
  anchorRef: RefObject<View | null>;
}

interface PluginAttachmentPickerBinding {
  menuItems: AttachmentMenuItem[];
  newAgentShortcutItems: AttachmentMenuItem[];
  picker: ReactElement | null;
}

function searchEmptyText(error: unknown, isFetching: boolean): string {
  if (error instanceof Error) return error.message;
  if (error) return String(error);
  return isFetching ? "Searching..." : "No results";
}

function installedAttachmentSources(
  plugins: InstalledPlugin[],
  serverId: string,
): InstalledAttachmentSource[] {
  return plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      plugin.attachmentSources.map((source) => ({
        plugin,
        source,
        key: `${plugin.id}/${source.id}`,
      })),
    );
}

function attachmentOptions(items: PluginAttachmentItem[]): ComboboxOption[] {
  return items.map((item) => {
    const isChatHistory = item.contextKind === "chat_history";
    return {
      id: item.id,
      label: isChatHistory ? item.title : `${item.identifier} ${item.title}`,
      description: item.subtitle,
      ...(isChatHistory ? { descriptionLayout: "stacked", searchText: item.identifier } : {}),
    };
  });
}

export function usePluginAttachmentPicker(
  input: PluginAttachmentPickerInput,
): PluginAttachmentPickerBinding {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const sources = useMemo(
    () => installedAttachmentSources(plugins, input.serverId),
    [input.serverId, plugins],
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const active = sources.find((candidate) => candidate.key === activeKey) ?? null;
  const trimmedQuery = query.trim();
  const search = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-search",
        input.serverId,
        active?.plugin.id ?? "",
        active?.source.id ?? "",
        trimmedQuery,
      ],
      queryFn: async () => {
        if (!input.client || !active) throw new Error("Plugin host is offline");
        const client = input.client;
        return searchPluginAttachments(
          active.source,
          (method, rpcInput) => client.invokePluginRpc(active.plugin.id, method, rpcInput),
          trimmedQuery,
        );
      },
      enabled: input.connected && active !== null,
      dataShape: "list",
      staleTimeMs: SEARCH_STALE_TIME_MS,
    },
    active?.plugin.queryClient,
  );
  const items = search.error
    ? EMPTY_ATTACHMENT_ITEMS
    : (search.data?.items ?? EMPTY_ATTACHMENT_ITEMS);
  const options = useMemo(() => attachmentOptions(items), [items]);
  const close = useCallback(() => {
    setActiveKey(null);
    setQuery("");
  }, []);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );
  const handleSelect = useCallback(
    (itemId: string) => {
      if (!active) return;
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return;
      const attachment = createPluginResourceAttachment(
        {
          pluginId: active.plugin.id,
          sourceId: active.source.id,
          sourceTitle: active.plugin.i18n.resolve(active.source.title, active.plugin.locale),
          sourceIcon: active.source.icon,
        },
        item,
      );
      input.onChangeAttachments(togglePluginResourceAttachment(input.attachments, attachment));
      close();
    },
    [active, close, input, items],
  );
  const menuItems = useMemo(
    () =>
      sources.map(({ key, source, plugin }) => ({
        id: `plugin:${key}`,
        label: `Attach ${plugin.i18n.resolve(source.title, plugin.locale)}`,
        icon: <ThemedSourceIcon icon={source.icon} uniProps={iconColorMapping} />,
        onSelect: () => setActiveKey(key),
      })),
    [sources],
  );
  const newAgentShortcutItems = useMemo(() => {
    const shortcutIds = new Set(
      sources
        .filter(({ source }) => source.newAgentShortcut === true)
        .map(({ key }) => `plugin:${key}`),
    );
    return menuItems.filter((item) => shortcutIds.has(item.id));
  }, [menuItems, sources]);
  const hostLabel = hosts.find((host) => host.serverId === active?.plugin.serverId)?.label;
  const sourceHostHeader = useMemo(
    () =>
      hostLabel ? (
        <Text testID="plugin-attachment-source-host" numberOfLines={1} style={styles.sourceHost}>
          {hostLabel}
        </Text>
      ) : undefined,
    [hostLabel],
  );
  if (!active) return { menuItems, newAgentShortcutItems, picker: null };
  return {
    menuItems,
    newAgentShortcutItems,
    picker: (
      <Combobox
        options={options}
        value=""
        onSelect={handleSelect}
        searchable
        searchPlaceholder={active.plugin.i18n.resolve(
          active.source.searchPlaceholder,
          active.plugin.locale,
        )}
        title={active.plugin.i18n.resolve(active.source.pickerTitle, active.plugin.locale)}
        stickyHeader={sourceHostHeader}
        open
        onOpenChange={handleOpenChange}
        onSearchQueryChange={setQuery}
        desktopPlacement="top-start"
        anchorRef={input.anchorRef}
        emptyText={searchEmptyText(search.error, search.isFetching)}
      />
    ),
  };
}

const styles = StyleSheet.create((theme) => ({
  sourceHost: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
}));
