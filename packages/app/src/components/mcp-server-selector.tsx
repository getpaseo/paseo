import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Terminal, Globe, Radio } from "lucide-react-native";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import type { McpServerRecord } from "@server/server/mcp/mcp-server-types";
import type { McpServerConfig } from "@server/server/agent/agent-sdk-types";
import type { McpServerType } from "@/components/mcp-server-modal";

const TYPE_ICONS: Record<McpServerType, typeof Terminal> = {
  stdio: Terminal,
  http: Globe,
  sse: Radio,
};

interface McpServerSelectorProps {
  serverId: string;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function McpServerSelector({
  serverId,
  selectedIds,
  onSelectionChange,
  disabled = false,
}: McpServerSelectorProps) {
  const { theme } = useUnistyles();
  const { servers, isLoading, error } = useMcpServers(serverId);
  const [isExpanded, setIsExpanded] = useState(false);

  const selectedServers = useMemo(() => {
    if (!servers) return [];
    return servers.filter((s) => selectedIds.includes(s.id));
  }, [servers, selectedIds]);

  const handleToggle = useCallback(
    (id: string) => {
      if (disabled) return;
      if (selectedIds.includes(id)) {
        onSelectionChange(selectedIds.filter((i) => i !== id));
      } else {
        onSelectionChange([...selectedIds, id]);
      }
    },
    [disabled, selectedIds, onSelectionChange],
  );

  const summary = useMemo(() => {
    if (!servers || servers.length === 0) return "None";
    if (selectedIds.length === 0) return "None";
    if (selectedIds.length === 1) return selectedServers[0]?.name ?? "1 selected";
    return `${selectedIds.length} servers selected`;
  }, [servers, selectedIds, selectedServers]);

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.header, disabled && styles.headerDisabled]}
        onPress={() => !disabled && setIsExpanded((v) => !v)}
        disabled={disabled || isLoading || !servers || servers.length === 0}
      >
        <View style={styles.headerContent}>
          <Text style={styles.label}>MCP Servers</Text>
          <Text style={styles.summary}>{summary}</Text>
        </View>
        {servers && servers.length > 0 ? (
          isExpanded ? (
            <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          )
        ) : null}
      </Pressable>

      {isExpanded && servers && servers.length > 0 && (
        <View style={styles.list}>
          {servers.map((server) => {
            const Icon = TYPE_ICONS[server.type] ?? Terminal;
            const isSelected = selectedIds.includes(server.id);
            return (
              <Pressable
                key={server.id}
                style={[styles.item, isSelected && styles.itemSelected]}
                onPress={() => handleToggle(server.id)}
              >
                <View style={[styles.itemIcon, !server.enabled && styles.itemIconDisabled]}>
                  <Icon
                    size={14}
                    color={server.enabled ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                </View>
                <View style={styles.itemContent}>
                  <Text style={[styles.itemName, !server.enabled && styles.itemNameDisabled]}>
                    {server.name}
                  </Text>
                  <Text style={styles.itemType}>
                    {server.type.toUpperCase()}
                    {!server.enabled && " (disabled)"}
                  </Text>
                </View>
                <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                  {isSelected ? <View style={styles.checkboxInner} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {isExpanded && isLoading && (
        <View style={styles.loading}>
          <Text style={styles.loadingText}>Loading MCP servers...</Text>
        </View>
      )}

      {isExpanded && error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {isExpanded && servers && servers.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No MCP servers configured</Text>
          <Text style={styles.emptyHint}>Add MCP servers in Settings → MCP Servers</Text>
        </View>
      )}
    </View>
  );
}

export function buildMcpServersConfig(
  servers: McpServerRecord[],
  ids: string[],
): Record<string, McpServerConfig> | undefined {
  const selected = servers.filter((s) => ids.includes(s.id) && s.enabled);
  if (selected.length === 0) return undefined;
  return selected.reduce(
    (acc, s) => {
      acc[s.name] = s.config;
      return acc;
    },
    {} as Record<string, McpServerConfig>,
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
  },
  headerDisabled: {
    opacity: 0.5,
  },
  headerContent: {
    flex: 1,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  list: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[4],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  itemSelected: {
    backgroundColor: theme.colors.surface3,
  },
  itemIcon: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  itemIconDisabled: {
    opacity: 0.5,
  },
  itemContent: {
    flex: 1,
  },
  itemName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  itemNameDisabled: {
    color: theme.colors.foregroundMuted,
  },
  itemType: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  checkboxInner: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.white,
  },
  loading: {
    padding: theme.spacing[3],
    alignItems: "center",
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    padding: theme.spacing[3],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    padding: theme.spacing[3],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
}));
