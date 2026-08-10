import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ManagedMcpServerPatch, ManagedMcpServerView } from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createManagedMcpServerFormState,
  managedMcpViewToPatch,
  type ManagedMcpServerFormState,
} from "./managed-mcp-server-form";
import { ManagedMcpServerModal } from "./managed-mcp-server-modal";

interface ManagedMcpServersCardProps {
  serverId: string;
}

interface EditorState {
  key: number;
  mode: "add" | "edit";
  initial: ManagedMcpServerFormState;
}

interface TestState {
  status: "pending" | "success" | "error";
  message?: string;
}

function serverDescription(server: ManagedMcpServerView): string {
  if (server.type === "stdio") {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url;
}

interface ManagedMcpServerRowProps {
  name: string;
  server: ManagedMcpServerView;
  isFirst: boolean;
  testState: TestState | undefined;
  onToggle: (name: string, server: ManagedMcpServerView, enabled: boolean) => void;
  onTest: (name: string) => void;
  onEdit: (name: string, server: ManagedMcpServerView) => void;
  onRemove: (name: string) => void;
}

function ManagedMcpServerRow({
  name,
  server,
  isFirst,
  testState,
  onToggle,
  onTest,
  onEdit,
  onRemove,
}: ManagedMcpServerRowProps) {
  const { t } = useTranslation();
  const handleToggle = useCallback(
    (enabled: boolean) => onToggle(name, server, enabled),
    [name, onToggle, server],
  );
  const handleTest = useCallback(() => onTest(name), [name, onTest]);
  const handleEdit = useCallback(() => onEdit(name, server), [name, onEdit, server]);
  const handleRemove = useCallback(() => onRemove(name), [name, onRemove]);

  return (
    <View
      style={[styles.serverRow, !isFirst && settingsStyles.rowBorder]}
      testID={`managed-mcp-row-${name}`}
    >
      <View style={styles.serverMain}>
        <View style={styles.serverHeading}>
          <Text style={styles.serverName}>{name}</Text>
          <Text style={styles.transport}>{server.type.toUpperCase()}</Text>
        </View>
        <Text style={styles.description} numberOfLines={2}>
          {serverDescription(server)}
        </Text>
        {testState && testState.status !== "pending" ? (
          <Alert
            variant={testState.status === "success" ? "success" : "error"}
            description={testState.message}
            testID={`managed-mcp-test-result-${name}`}
          />
        ) : null}
      </View>
      <View style={styles.actions}>
        <Switch
          value={server.enabled !== false}
          onValueChange={handleToggle}
          accessibilityLabel={t("settings.host.orchestration.managedMcp.enable", { name })}
        />
        <Button
          variant="ghost"
          size="sm"
          onPress={handleTest}
          loading={testState?.status === "pending"}
          disabled={testState?.status === "pending"}
          testID={`managed-mcp-test-${name}`}
        >
          {t("settings.host.orchestration.managedMcp.test")}
        </Button>
        <Button variant="ghost" size="sm" onPress={handleEdit} testID={`managed-mcp-edit-${name}`}>
          {t("settings.host.orchestration.managedMcp.edit")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleRemove}
          testID={`managed-mcp-remove-${name}`}
        >
          {t("settings.host.orchestration.managedMcp.remove")}
        </Button>
      </View>
    </View>
  );
}

export function ManagedMcpServersCard({ serverId }: ManagedMcpServersCardProps) {
  const { t } = useTranslation();
  const supportsManagedMcp = useHostFeature(serverId, "hostManagedMcpServers");
  const client = useHostRuntimeClient(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const servers = useMemo(() => config?.mcp.servers ?? {}, [config?.mcp.servers]);
  const entries = useMemo(
    () => Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)),
    [servers],
  );

  const handleOpenAdd = useCallback(() => {
    setEditor({ key: Date.now(), mode: "add", initial: createManagedMcpServerFormState() });
  }, []);

  const handleOpenEdit = useCallback((name: string, server: ManagedMcpServerView) => {
    setEditor({
      key: Date.now(),
      mode: "edit",
      initial: createManagedMcpServerFormState(name, server),
    });
  }, []);

  const handleCloseEditor = useCallback(() => setEditor(null), []);

  const handleSave = useCallback(
    async (name: string, server: ManagedMcpServerPatch) => {
      if (editor?.mode === "add" && servers[name]) {
        throw new Error(t("settings.host.orchestration.managedMcp.duplicateName", { name }));
      }
      await patchConfig({ upsertMcpServers: { [name]: server } });
    },
    [editor?.mode, patchConfig, servers, t],
  );

  const handleToggle = useCallback(
    async (name: string, server: ManagedMcpServerView, enabled: boolean) => {
      try {
        await patchConfig({
          upsertMcpServers: {
            [name]: { ...managedMcpViewToPatch(server), enabled },
          },
        });
      } catch (error) {
        setTestStates((current) => ({
          ...current,
          [name]: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : t("settings.host.orchestration.managedMcp.updateFailed"),
          },
        }));
      }
    },
    [patchConfig, t],
  );

  const handleRemove = useCallback(
    async (name: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.host.orchestration.managedMcp.removeTitle"),
        message: t("settings.host.orchestration.managedMcp.removeMessage", { name }),
        confirmLabel: t("settings.host.orchestration.managedMcp.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await patchConfig({ removeMcpServers: [name] });
        setTestStates((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      } catch (error) {
        setTestStates((current) => ({
          ...current,
          [name]: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : t("settings.host.orchestration.managedMcp.removeFailed"),
          },
        }));
      }
    },
    [patchConfig, t],
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!client) return;
      setTestStates((current) => ({ ...current, [name]: { status: "pending" } }));
      try {
        const result = await client.testManagedMcpServer(name);
        setTestStates((current) => ({
          ...current,
          [name]:
            result.status === "success"
              ? {
                  status: "success",
                  message: t("settings.host.orchestration.managedMcp.connected", {
                    latencyMs: result.latencyMs,
                    toolCount: result.toolCount ?? 0,
                  }),
                }
              : {
                  status: "error",
                  message: result.error ?? t("settings.host.orchestration.managedMcp.rejected"),
                },
        }));
      } catch (error) {
        setTestStates((current) => ({
          ...current,
          [name]: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : t("settings.host.orchestration.managedMcp.testFailed"),
          },
        }));
      }
    },
    [client, t],
  );

  if (!supportsManagedMcp) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-managed-mcp-card">
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.managedMcp.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.managedMcp.hint")}
            </Text>
          </View>
          <Button variant="outline" size="sm" onPress={handleOpenAdd} testID="managed-mcp-add">
            {t("settings.host.orchestration.managedMcp.addServer")}
          </Button>
        </View>

        {entries.length === 0 ? (
          <Text style={styles.empty}>{t("settings.host.orchestration.managedMcp.empty")}</Text>
        ) : (
          entries.map(([name, server], index) => (
            <ManagedMcpServerRow
              key={name}
              name={name}
              server={server}
              isFirst={index === 0}
              testState={testStates[name]}
              onToggle={handleToggle}
              onTest={handleTest}
              onEdit={handleOpenEdit}
              onRemove={handleRemove}
            />
          ))
        )}
      </View>

      {editor ? (
        <ManagedMcpServerModal
          key={editor.key}
          mode={editor.mode}
          initialState={editor.initial}
          onClose={handleCloseEditor}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  serverRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  serverMain: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  serverHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  serverName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  transport: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
}));
