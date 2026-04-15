// IntegrationSelector — issue/thread selector for task creation
// Fetches issues from connected integrations via daemon RPC.
// Shows a search-and-select dropdown when the integration is connected,
// or a "Not connected" badge when it's not.

import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, TextInput, FlatList, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, Search, ExternalLink, ChevronDown } from "lucide-react-native";
import type { IntegrationRegistryEntry, IntegrationId } from "@/types/kanban";
import { IntegrationIcon } from "@/components/kanban/integration-context";
import { useIntegrationSearch } from "@/hooks/use-integration-status";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { isWeb } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";

interface IntegrationSelectorProps {
  integration: IntegrationRegistryEntry;
  onSelect: (value: string | undefined) => void;
  onSelectItem?: (item: Record<string, unknown> | undefined) => void;
  isConnected?: boolean;
  serverId?: string;
  cwd?: string;
  searchSeed?: string;
}

export function IntegrationSelector({
  integration,
  onSelect,
  onSelectItem,
  isConnected = false,
  serverId,
  cwd,
  searchSeed,
}: IntegrationSelectorProps) {
  const { theme } = useUnistyles();
  const [showSelector, setShowSelector] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<Record<string, unknown> | null>(null);

  // Local fetch state — avoids relying on TanStack Query's `refetch()` on a
  // disabled query (which is unreliable in v5 and caused "Loading..." to hang).
  // We fetch imperatively in handleOpen so isFetchingItems=true is guaranteed
  // to be set in the same React batch as showSelector=true.
  const [fetchedItems, setFetchedItems] = useState<Record<string, unknown>[]>([]);
  const [isFetchingItems, setIsFetchingItems] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const searchMutation = useIntegrationSearch(serverId);

  // Items to display: search results if searching, otherwise the fetched list
  const items = searchQuery.trim() ? (searchMutation.data?.items ?? []) : fetchedItems;
  const isSearching = searchMutation.isPending;
  const isFetching = isFetchingItems;

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim() || !showSelector) return;
    const timer = setTimeout(() => {
      searchMutation.mutate({
        integrationId: integration.id,
        query: searchQuery.trim(),
        cwd,
        limit: 15,
      });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, showSelector]);

  const handleOpen = useCallback(async () => {
    console.log(`[IntegrationSelector] handleOpen called`, {
      integrationId: integration.id,
      isConnected,
      serverId,
      cwd,
    });

    if (!isConnected) {
      console.warn(`[IntegrationSelector] BLOCKED — isConnected=false for ${integration.id}`);
      return;
    }

    // Set both flags in the same synchronous batch so the dropdown renders
    // immediately with isFetchingItems=true → "Loading..." is shown right away.
    setSearchQuery("");
    setFetchedItems([]);
    setFetchError(null);
    setIsFetchingItems(true);
    setShowSelector(true);

    try {
      const client = getHostRuntimeStore().getClient(serverId ?? "");
      console.log(`[IntegrationSelector] client resolved:`, {
        hasClient: !!client,
        serverId,
      });

      if (!client) {
        console.error(`[IntegrationSelector] NO CLIENT for serverId="${serverId}"`);
        throw new Error("No client");
      }

      console.log(`[IntegrationSelector] calling fetchIntegrationItems...`, {
        integrationId: integration.id,
        cwd,
      });
      const result = await client.fetchIntegrationItems({ integrationId: integration.id, cwd });
      console.log(`[IntegrationSelector] fetchIntegrationItems response:`, {
        integrationId: integration.id,
        itemCount: result?.items?.length ?? 0,
        error: result?.error,
        rawResult: JSON.stringify(result).slice(0, 500),
      });

      if (result.error) {
        console.warn(`[IntegrationSelector] API error for ${integration.id}: ${result.error}`);
        setFetchError(result.error);
      }
      setFetchedItems(result.items ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[IntegrationSelector] fetchIntegrationItems FAILED for ${integration.id}:`,
        err,
      );
      setFetchError(message);
      setFetchedItems([]);
    } finally {
      setIsFetchingItems(false);
      console.log(`[IntegrationSelector] handleOpen complete for ${integration.id}`);
    }
  }, [isConnected, serverId, integration.id, cwd]);

  const handleSelect = useCallback(
    (item: Record<string, unknown>) => {
      setSelectedItem(item);
      setShowSelector(false);
      setSearchQuery("");
      // Use the identifier that makes most sense per provider
      const id = String(item.identifier ?? item.key ?? item.number ?? item.id ?? "");
      onSelect(id);
      onSelectItem?.(item);
    },
    [onSelect, onSelectItem],
  );

  const handleClear = useCallback(() => {
    setSelectedItem(null);
    onSelect(undefined);
    onSelectItem?.(undefined);
  }, [onSelect, onSelectItem]);

  const labelText = (() => {
    switch (integration.id) {
      case "github":
        return "GitHub issue";
      case "linear":
        return "Linear issue";
      case "jira":
        return "Jira issue";
      case "gitlab":
        return "GitLab issue";
      case "plain":
        return "Plain thread";
      case "forgejo":
        return "Forgejo issue";
      case "sentry":
        return "Sentry issue";
      default:
        return `${integration.name} issue`;
    }
  })();

  const getItemLabel = (item: Record<string, unknown>): string => {
    const identifier =
      item.identifier ?? item.key ?? (item.number != null ? `#${item.number}` : null) ?? "";
    const title = String(item.title ?? item.previewText ?? "");
    return identifier ? `${identifier} - ${title}` : title;
  };

  return (
    <View style={selectorStyles.container}>
      {selectedItem ? (
        <Pressable
          style={({ pressed }) => [
            selectorStyles.selectedRow,
            pressed && selectorStyles.selectedRowPressed,
          ]}
          onPress={handleOpen}
        >
          <IntegrationIcon integration={integration.id} size={16} color={theme.colors.foreground} />
          <View style={selectorStyles.selectedContent}>
            <Text style={selectorStyles.selectedIdentifier}>
              {String(selectedItem.identifier ?? selectedItem.key ?? selectedItem.number ?? "")}
            </Text>
            <Text style={selectorStyles.selectedTitle} numberOfLines={1}>
              {String(selectedItem.title ?? selectedItem.previewText ?? "Untitled")}
            </Text>
          </View>
          <Pressable
            style={selectorStyles.clearButton}
            onPress={(e) => {
              e.stopPropagation?.();
              handleClear();
            }}
            hitSlop={8}
          >
            <X size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [
            selectorStyles.selectButton,
            pressed && selectorStyles.selectButtonPressed,
          ]}
          onPress={handleOpen}
        >
          <IntegrationIcon integration={integration.id} size={16} color={theme.colors.foregroundMuted} />
          <Text style={selectorStyles.selectButtonText}>{labelText}</Text>
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}

      {/* Selected item display */}
      {selectedItem ? (
        <View style={selectorStyles.selectedItem}>
          <Check size={12} color={theme.colors.foreground} />
          <Text style={selectorStyles.selectedText} numberOfLines={1}>
            {getItemLabel(selectedItem)}
          </Text>
        </View>
      ) : null}

      {/* Selector dropdown */}
      {showSelector ? (
        <View style={selectorStyles.dropdown}>
          <View style={selectorStyles.searchRow}>
            <Search size={14} color={theme.colors.foregroundMuted} />
            <TextInput
              // @ts-expect-error - outlineStyle is web-only
              style={[selectorStyles.searchInput, isWeb && { outlineStyle: "none" }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={`Search ${integration.name.toLowerCase()} issues...`}
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {isSearching ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : null}
          </View>

          {isFetching && !searchQuery ? (
            <View style={selectorStyles.loadingRow}>
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
              <Text style={selectorStyles.loadingText}>Loading {integration.name} items...</Text>
            </View>
          ) : fetchError && items.length === 0 && !searchQuery ? (
            <View style={selectorStyles.emptyRow}>
              <Text style={selectorStyles.emptyText}>{fetchError}</Text>
            </View>
          ) : items.length === 0 ? (
            <View style={selectorStyles.emptyRow}>
              <Text style={selectorStyles.emptyText}>
                {searchQuery ? "No results found" : "No issues available"}
              </Text>
            </View>
          ) : (
            <FlatList
              data={items.slice(0, 10)}
              keyExtractor={(item, index) => String(item.id ?? index)}
              style={selectorStyles.list}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const identifier = String(
                  item.identifier ?? item.key ?? item.number ?? item.id ?? integration.name,
                );
                const title = String(item.title ?? item.previewText ?? item.name ?? "Untitled");
                const stateRaw = item.state ?? item.status;
                const stateName =
                  typeof stateRaw === "string"
                    ? stateRaw
                    : ((stateRaw as Record<string, unknown> | undefined)?.name as string | undefined);
                const assigneeRaw = item.assignee;
                const assigneeName =
                  typeof assigneeRaw === "string"
                    ? assigneeRaw
                    : ((assigneeRaw as Record<string, unknown> | undefined)?.name ??
                       (assigneeRaw as Record<string, unknown> | undefined)?.login) as string | undefined;
                const description = (item.description ?? item.body) as string | undefined;
                const itemUrl = (item.url ?? item.webUrl ?? item.html_url) as string | undefined;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      selectorStyles.listItem,
                      pressed && selectorStyles.listItemPressed,
                    ]}
                    onPress={() => handleSelect(item)}
                  >
                    <View style={selectorStyles.listItemHeader}>
                      <Text style={selectorStyles.listItemEyebrow} numberOfLines={1}>
                        {identifier}
                      </Text>
                      {stateName ? (
                        <View style={selectorStyles.statusBadge}>
                          <Text style={selectorStyles.statusText}>{stateName}</Text>
                        </View>
                      ) : null}
                      <View style={selectorStyles.listItemHeaderSpacer} />
                      {itemUrl ? (
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation?.();
                            void openExternalUrl(itemUrl);
                          }}
                          hitSlop={6}
                          style={({ pressed }) => [
                            selectorStyles.externalLinkButton,
                            pressed && selectorStyles.externalLinkButtonPressed,
                          ]}
                        >
                          <ExternalLink size={11} color={theme.colors.foregroundMuted} />
                        </Pressable>
                      ) : null}
                    </View>
                    <Text style={selectorStyles.listItemText} numberOfLines={1}>
                      {title}
                    </Text>
                    {description ? (
                      <Text style={selectorStyles.listItemDescription} numberOfLines={2}>
                        {description}
                      </Text>
                    ) : null}
                    {assigneeName ? (
                      <Text style={selectorStyles.listItemMeta} numberOfLines={1}>
                        {assigneeName}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              }}
            />
          )}

          <Pressable
            style={({ pressed }) => [
              selectorStyles.cancelButton,
              pressed && selectorStyles.cancelButtonPressed,
            ]}
            onPress={() => {
              setShowSelector(false);
              setSearchQuery("");
            }}
          >
            <Text style={selectorStyles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const selectorStyles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  selectButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2] + 2,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  selectButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  selectButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  selectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  selectedRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  selectedContent: {
    flex: 1,
    minWidth: 0,
  },
  selectedIdentifier: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.semibold,
  },
  selectedTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    marginTop: 1,
  },
  clearButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
  },
  dropdown: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    padding: 0,
    minHeight: 24,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  loadingText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  emptyRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  list: {
    maxHeight: 220,
  },
  listItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  listItemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  listItemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  listItemHeaderSpacer: {
    flex: 1,
  },
  externalLinkButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  externalLinkButtonPressed: {
    opacity: 0.6,
  },
  listItemEyebrow: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.semibold,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[1] + 2,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  statusText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  listItemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    marginTop: 2,
  },
  listItemDescription: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
    lineHeight: 15,
  },
  listItemMeta: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  cancelButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  cancelButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  cancelText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
}));
