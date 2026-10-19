import { useCallback, useMemo, useState, type ReactElement, type RefObject } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginAttachmentItem, PluginAttachmentSourceContribution } from "@getpaseo/plugin";
import { searchPluginAttachments } from "@getpaseo/plugin/client/host";
import type { LucideIcon } from "lucide-react-native";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useFetchQuery } from "@/data/query";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolvePluginIcon } from "../icons";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { createPluginResourceAttachment, togglePluginResourceAttachment } from "./model";

const SEARCH_STALE_TIME_MS = 30_000;
const EMPTY_ATTACHMENT_ITEMS: PluginAttachmentItem[] = [];
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function SourceIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={ICON_SIZE.md} color={color} />;
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
  return items.map((item) => ({
    id: item.id,
    label: `${item.identifier} ${item.title}`,
    description: item.subtitle,
  }));
}

function PluginAttachmentPicker({
  input,
  active,
  onSelect,
  onOpenChange,
}: {
  input: PluginAttachmentPickerInput;
  active: InstalledAttachmentSource;
  onSelect: (item: PluginAttachmentItem) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const search = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-search",
        input.serverId,
        active.plugin.id,
        active.source.id,
        trimmedQuery,
      ],
      queryFn: async () => {
        if (!input.client) throw new Error("Plugin host is offline");
        const client = input.client;
        return searchPluginAttachments(
          active.source,
          (method, rpcInput) => client.invokePluginRpc(active.plugin.id, method, rpcInput),
          trimmedQuery,
        );
      },
      enabled: input.connected,
      dataShape: "list",
      staleTimeMs: SEARCH_STALE_TIME_MS,
    },
    active.plugin.queryClient,
  );
  const items = search.error
    ? EMPTY_ATTACHMENT_ITEMS
    : (search.data?.items ?? EMPTY_ATTACHMENT_ITEMS);
  const options = useMemo(() => attachmentOptions(items), [items]);
  const handleSelect = useCallback(
    (itemId: string) => {
      const item = items.find((candidate) => candidate.id === itemId);
      if (item) onSelect(item);
    },
    [items, onSelect],
  );
  return (
    <Combobox
      options={options}
      value=""
      onSelect={handleSelect}
      searchable
      searchPlaceholder={active.source.searchPlaceholder}
      title={active.source.pickerTitle}
      open
      onOpenChange={onOpenChange}
      onSearchQueryChange={setQuery}
      desktopPlacement="top-start"
      anchorRef={input.anchorRef}
      emptyText={searchEmptyText(search.error, search.isFetching)}
    />
  );
}

export function usePluginAttachmentPicker(
  input: PluginAttachmentPickerInput,
): PluginAttachmentPickerBinding {
  const plugins = useInstalledPlugins();
  const sources = useMemo(
    () => installedAttachmentSources(plugins, input.serverId),
    [input.serverId, plugins],
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = sources.find((candidate) => candidate.key === activeKey) ?? null;
  const close = useCallback(() => {
    setActiveKey(null);
  }, []);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );
  const handleSelect = useCallback(
    (item: PluginAttachmentItem) => {
      if (!active) return;
      const attachment = createPluginResourceAttachment(
        {
          pluginId: active.plugin.id,
          sourceId: active.source.id,
          sourceTitle: active.source.title,
          sourceIcon: active.source.icon,
        },
        item,
      );
      const attachments = togglePluginResourceAttachment(input.attachments, attachment);
      input.onChangeAttachments(attachments);
      close();
      const onSelect = active.source.onSelect;
      if (attachments.length > input.attachments.length && onSelect) {
        void Promise.resolve()
          .then(() => onSelect({ ...item }))
          .then(() =>
            active.plugin.queryClient.invalidateQueries({
              queryKey: [
                "plugin-attachment-search",
                input.serverId,
                active.plugin.id,
                active.source.id,
              ],
            }),
          )
          .catch((error: unknown) => {
            console.warn(`[Plugins] Attachment selection callback failed for ${active.key}`, error);
          });
      }
    },
    [active, close, input],
  );
  const menuItems = useMemo(
    () =>
      sources.map(({ key, source }) => {
        const Icon = resolvePluginIcon(source.icon);
        return {
          id: `plugin:${key}`,
          label: `Attach ${source.title}`,
          icon: <ThemedSourceIcon Icon={Icon} uniProps={iconColorMapping} />,
          onSelect: () => setActiveKey(key),
        };
      }),
    [sources],
  );
  if (!active) return { menuItems, picker: null };
  return {
    menuItems,
    picker: (
      <PluginAttachmentPicker
        key={active.key}
        input={input}
        active={active}
        onSelect={handleSelect}
        onOpenChange={handleOpenChange}
      />
    ),
  };
}
