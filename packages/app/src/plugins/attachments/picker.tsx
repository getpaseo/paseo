import { useCallback, useMemo, useState, type ReactElement, type RefObject } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginAttachmentItem, PluginSerializableIcon } from "@getpaseo/plugin";
import type { PluginAttachmentSourceContribution } from "../types";
import { searchPluginAttachments } from "@getpaseo/plugin/client/host";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
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
  hostLabel: string;
  remote: boolean;
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
  hosts: readonly { serverId: string; label: string }[],
): InstalledAttachmentSource[] {
  return plugins.flatMap((plugin) =>
    plugin.attachmentSources
      .filter((source) => plugin.serverId === serverId || source.crossHost === true)
      .map((source) => ({
        plugin,
        source,
        key: `${plugin.serverId}/${plugin.id}/${source.id}`,
        hostLabel:
          hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId,
        remote: plugin.serverId !== serverId,
      })),
  );
}

function attachmentOptions(items: PluginAttachmentItem[]): ComboboxOption[] {
  return items.map((item) => ({
    id: item.id,
    label: `${item.identifier} ${item.title}`,
    description: item.subtitle,
  }));
}

export function usePluginAttachmentPicker(
  input: PluginAttachmentPickerInput,
): PluginAttachmentPickerBinding {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const sources = useMemo(
    () => installedAttachmentSources(plugins, input.serverId, hosts),
    [input.serverId, plugins, hosts],
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [approvedRemoteKey, setApprovedRemoteKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const active = sources.find((candidate) => candidate.key === activeKey) ?? null;
  const trimmedQuery = query.trim();
  const search = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-search",
        active?.plugin.serverId ?? "",
        active?.plugin.id ?? "",
        active?.source.id ?? "",
        trimmedQuery,
      ],
      queryFn: async () => {
        if (!active) throw new Error("Attachment source is unavailable");
        const sourceHost = active.remote
          ? getHostRuntimeStore().getSnapshot(active.plugin.serverId)
          : null;
        const client = active.remote ? sourceHost?.client : input.client;
        if (!client || (active.remote && sourceHost?.connectionStatus !== "online")) {
          throw new Error(`Source host ${active.hostLabel} is offline`);
        }
        return searchPluginAttachments(
          active.source,
          (method, rpcInput) => client.invokePluginRpc(active.plugin.id, method, rpcInput),
          trimmedQuery,
        );
      },
      enabled:
        input.connected && active !== null && (!active.remote || approvedRemoteKey === active.key),
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
    setApprovedRemoteKey(null);
    setQuery("");
  }, []);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );
  const handleApproveRemote = useCallback(() => {
    if (active) setApprovedRemoteKey(active.key);
  }, [active]);
  const handleSelect = useCallback(
    (itemId: string) => {
      if (!active) return;
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return;
      const attachment = createPluginResourceAttachment(
        {
          pluginId: active.plugin.id,
          sourceId: active.source.id,
          sourceTitle: active.remote
            ? `${active.plugin.i18n.resolve(active.source.title, active.plugin.locale)} · ${active.hostLabel}`
            : active.plugin.i18n.resolve(active.source.title, active.plugin.locale),
          sourceIcon: active.source.icon,
          ...(active.remote ? { sourceServerId: active.plugin.serverId } : {}),
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
      sources.map(({ key, source, plugin, remote, hostLabel }) => {
        const title = plugin.i18n.resolve(source.title, plugin.locale);
        return {
          id: `plugin:${key}`,
          label: remote ? `Attach ${title} from ${hostLabel}` : `Attach ${title}`,
          icon: <ThemedSourceIcon icon={source.icon} uniProps={iconColorMapping} />,
          onSelect: () => setActiveKey(key),
        };
      }),
    [sources],
  );
  const newAgentShortcutItems = useMemo(() => {
    const shortcutIds = new Set(
      sources
        .filter(({ source, remote }) => !remote && source.newAgentShortcut === true)
        .map(({ key }) => `plugin:${key}`),
    );
    return menuItems.filter((item) => shortcutIds.has(item.id));
  }, [menuItems, sources]);
  if (!active) return { menuItems, newAgentShortcutItems, picker: null };
  if (active.remote && approvedRemoteKey !== active.key) {
    return {
      menuItems,
      newAgentShortcutItems,
      picker: (
        <Combobox
          options={[
            {
              id: "browse",
              label: `Search ${active.plugin.i18n.resolve(active.source.title, active.plugin.locale)} on ${active.hostLabel}`,
              description:
                "Readable results will be copied to this app. Your selected snapshot goes to the destination host when you send.",
            },
          ]}
          value=""
          onSelect={handleApproveRemote}
          keepOpenOnSelect
          title={`Use ${active.hostLabel} as the source?`}
          open
          onOpenChange={handleOpenChange}
          desktopPlacement="top-start"
          anchorRef={input.anchorRef}
        />
      ),
    };
  }
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
        title={
          active.remote
            ? `${active.plugin.i18n.resolve(active.source.pickerTitle, active.plugin.locale)} from ${active.hostLabel}`
            : active.plugin.i18n.resolve(active.source.pickerTitle, active.plugin.locale)
        }
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
