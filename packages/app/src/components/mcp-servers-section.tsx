import { useCallback, useState } from "react";
import { View, Text, Pressable, Switch } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Plus,
  Terminal,
  Globe,
  Radio,
  Pencil,
  Trash2,
  RefreshCw,
  ChevronRight,
} from "lucide-react-native";
import {
  useMcpServers,
  useCreateMcpServer,
  useUpdateMcpServer,
  useDeleteMcpServer,
  useToggleMcpServer,
} from "@/hooks/use-mcp-servers";
import { McpServerModal, type McpServerType } from "@/components/mcp-server-modal";
import { Button } from "@/components/ui/button";
import type { McpServerRecord } from "@server/server/mcp/mcp-server-types";
import type { CreateMcpServerOptions } from "@server/client/daemon-client";

const TYPE_ICONS: Record<McpServerType, typeof Terminal> = {
  stdio: Terminal,
  http: Globe,
  sse: Radio,
};

interface McpServersSectionProps {
  serverId: string;
}

export function McpServersSection({ serverId }: McpServersSectionProps) {
  const { theme } = useUnistyles();
  const { servers, isLoading, isFetching, error, refetch, invalidate } = useMcpServers(serverId);
  const { create, isLoading: isCreating } = useCreateMcpServer(serverId);
  const { update } = useUpdateMcpServer(serverId);
  const { remove } = useDeleteMcpServer(serverId);
  const { toggle } = useToggleMcpServer(serverId);

  const [modalVisible, setModalVisible] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerRecord | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  const handleAdd = useCallback(() => {
    setEditingServer(undefined);
    setModalVisible(true);
  }, []);

  const handleEdit = useCallback((server: McpServerRecord) => {
    setEditingServer(server);
    setModalVisible(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setModalVisible(false);
    setEditingServer(undefined);
  }, []);

  const handleSave = useCallback(
    async (data: {
      name: string;
      type: McpServerType;
      config: Parameters<typeof create>[0]["config"];
      description?: string;
      tags?: string[];
      enabled: boolean;
    }) => {
      setIsSaving(true);
      try {
        if (editingServer) {
          await update(editingServer.id, {
            name: data.name,
            type: data.type,
            config: data.config,
            description: data.description,
            tags: data.tags,
            enabled: data.enabled,
          });
        } else {
          await create({
            name: data.name,
            type: data.type,
            config: data.config,
            description: data.description,
            tags: data.tags,
            enabled: data.enabled,
          });
        }
        handleCloseModal();
      } finally {
        setIsSaving(false);
      }
    },
    [editingServer, create, update, handleCloseModal],
  );

  const handleToggle = useCallback(
    async (server: McpServerRecord) => {
      await toggle({ id: server.id, enabled: !server.enabled });
    },
    [toggle],
  );

  const handleDelete = useCallback(
    async (server: McpServerRecord) => {
      await remove(server.id);
    },
    [remove],
  );

  return (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>MCP Servers</Text>
          <Pressable
            onPress={() => void refetch()}
            disabled={isFetching}
            style={[styles.refreshButton, isFetching && styles.refreshButtonDisabled]}
          >
            <RefreshCw
              size={theme.iconSize.sm}
              color={isFetching ? theme.colors.foregroundMuted : theme.colors.primary}
            />
          </Pressable>
        </View>

        {error ? (
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.errorText}>{error}</Text>
            <Button variant="secondary" size="sm" onPress={() => void invalidate()}>
              Retry
            </Button>
          </View>
        ) : isLoading ? (
          <View style={[styles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Loading MCP servers...</Text>
          </View>
        ) : !servers || servers.length === 0 ? (
          <View style={[styles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>No MCP servers configured</Text>
            <Text style={styles.emptyHint}>
              MCP servers let your agents use additional tools and capabilities.
            </Text>
          </View>
        ) : (
          servers.map((server) => {
            const Icon = TYPE_ICONS[server.type] ?? Terminal;
            return (
              <View key={server.id} style={styles.card}>
                <View style={styles.serverRow}>
                  <View style={styles.serverIcon}>
                    <Icon size={theme.iconSize.md} color={theme.colors.foreground} />
                  </View>
                  <View style={styles.serverInfo}>
                    <Text style={styles.serverName}>{server.name}</Text>
                    <Text style={styles.serverType}>
                      {server.type.toUpperCase()}
                      {server.description ? ` — ${server.description}` : ""}
                    </Text>
                    {server.tags && server.tags.length > 0 && (
                      <View style={styles.tagRow}>
                        {server.tags.map((tag) => (
                          <View key={tag} style={styles.tag}>
                            <Text style={styles.tagText}>{tag}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                  <Switch
                    value={server.enabled}
                    onValueChange={() => void handleToggle(server)}
                    trackColor={{ true: theme.colors.primary, false: theme.colors.surface3 }}
                    thumbColor={theme.colors.palette.white}
                  />
                </View>
                <View style={styles.serverActions}>
                  <Pressable
                    style={styles.actionButton}
                    onPress={() => void handleEdit(server)}
                    accessibilityLabel={`Edit ${server.name}`}
                  >
                    <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                  </Pressable>
                  <Pressable
                    style={styles.actionButton}
                    onPress={() => void handleDelete(server)}
                    accessibilityLabel={`Delete ${server.name}`}
                  >
                    <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
                  </Pressable>
                </View>
              </View>
            );
          })
        )}

        <Button
          variant="outline"
          size="sm"
          onPress={handleAdd}
          leftIcon={<Plus size={theme.iconSize.sm} color={theme.colors.primary} />}
          style={styles.addButton}
        >
          Add MCP Server
        </Button>
      </View>

      <McpServerModal
        visible={modalVisible}
        onClose={handleCloseModal}
        onSave={handleSave}
        server={editingServer}
        isLoading={isSaving || isCreating}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[3],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  refreshButton: {
    padding: theme.spacing[1],
  },
  refreshButtonDisabled: {
    opacity: 0.5,
  },
  card: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  emptyCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  errorCard: {
    borderWidth: 1,
    borderColor: theme.colors.destructive,
    alignItems: "flex-start",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  serverRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  serverIcon: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  serverInfo: {
    flex: 1,
    gap: 2,
  },
  serverName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  serverType: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  tag: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  tagText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  serverActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface3,
    paddingTop: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  actionButton: {
    padding: theme.spacing[1],
  },
  addButton: {
    marginTop: theme.spacing[1],
  },
}));
