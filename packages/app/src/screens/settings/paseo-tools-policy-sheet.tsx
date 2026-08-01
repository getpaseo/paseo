import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  PASEO_TOOL_MANIFEST,
  type PaseoToolManifestEntry,
} from "@getpaseo/protocol/paseo-tool-manifest";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { StyleSheet } from "react-native-unistyles";

interface PaseoToolGroup {
  name: string;
  tools: readonly PaseoToolManifestEntry[];
}

interface PaseoToolsPolicySheetProps {
  providerId: string;
  providerLabel: string;
  config: MutableDaemonConfig | null;
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

interface PaseoToolRowProps {
  tool: PaseoToolManifestEntry;
  isEnabled: boolean;
  disabled: boolean;
  isFirst: boolean;
  onChange: (tool: PaseoToolManifestEntry, enabled: boolean) => void;
}

const EMPTY_DISABLED_TOOLS: string[] = [];

function isBrowserTool(tool: PaseoToolManifestEntry): boolean {
  return tool.browser === true;
}

function toolMatchesQuery(tool: PaseoToolManifestEntry, query: string): boolean {
  return [tool.id, tool.label, tool.description].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

function groupTools(tools: readonly PaseoToolManifestEntry[]): PaseoToolGroup[] {
  const groups = new Map<string, PaseoToolManifestEntry[]>();
  for (const tool of tools) {
    const group = groups.get(tool.group);
    if (group) group.push(tool);
    else groups.set(tool.group, [tool]);
  }
  return Array.from(groups, ([name, group]) => ({ name, tools: group }));
}

const TOOL_GROUPS = groupTools(PASEO_TOOL_MANIFEST);

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PaseoToolRow({ tool, isEnabled, disabled, isFirst, onChange }: PaseoToolRowProps) {
  const { t } = useTranslation();
  const handleValueChange = useCallback(
    (enabled: boolean) => onChange(tool, enabled),
    [onChange, tool],
  );

  return (
    <View style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{tool.label}</Text>
        <Text style={settingsStyles.rowHint}>{tool.description}</Text>
      </View>
      <Switch
        value={isEnabled}
        onValueChange={handleValueChange}
        disabled={disabled}
        accessibilityLabel={t("settings.providers.tools.toolAccessibilityLabel", {
          name: tool.label,
        })}
        testID={`paseo-tool-${tool.id}-switch`}
      />
    </View>
  );
}

export function PaseoToolsPolicySheet({
  providerId,
  providerLabel,
  config,
  visible,
  onClose,
  onDismiss,
  patchConfig,
}: PaseoToolsPolicySheetProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const policy = config?.providers[providerId]?.paseoTools;
  const globalToolsEnabled = config?.mcp.injectIntoAgents !== false;
  const browserToolsEnabled = config?.browserTools.enabled === true;
  const disabledTools = policy?.disabledTools ?? EMPTY_DISABLED_TOOLS;
  const disabledToolSet = useMemo(() => new Set(disabledTools), [disabledTools]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return TOOL_GROUPS;
    return TOOL_GROUPS.flatMap((group) => {
      if (group.name.toLocaleLowerCase().includes(normalizedQuery)) return [group];
      const tools = group.tools.filter((tool) => toolMatchesQuery(tool, normalizedQuery));
      return tools.length > 0 ? [{ ...group, tools }] : [];
    });
  }, [normalizedQuery]);
  const controlsDisabled = !globalToolsEnabled || pendingAction !== null;

  const updatePolicy = useCallback(
    async (action: string, nextPolicy: { enabled?: boolean; disabledTools?: string[] }) => {
      setPendingAction(action);
      setError(null);
      try {
        const result = await patchConfig({
          providers: { [providerId]: { paseoTools: nextPolicy } },
        });
        if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      } catch (updateError) {
        setError(getErrorMessage(updateError));
      } finally {
        setPendingAction(null);
      }
    },
    [patchConfig, providerId, t],
  );

  const handleMasterChange = useCallback(
    (enabled: boolean) => void updatePolicy("master", { enabled }),
    [updatePolicy],
  );
  const handleToolChange = useCallback(
    (tool: PaseoToolManifestEntry, enabled: boolean) => {
      const nextDisabledTools = enabled
        ? disabledTools.filter((toolId) => toolId !== tool.id)
        : [...disabledTools, tool.id];
      void updatePolicy(tool.id, { disabledTools: nextDisabledTools });
    },
    [disabledTools, updatePolicy],
  );
  const handleBulkChange = useCallback(
    (enabled: boolean) => {
      const editableTools = PASEO_TOOL_MANIFEST.filter(
        (tool) => browserToolsEnabled || !isBrowserTool(tool),
      );
      const editableToolIds = new Set<string>(editableTools.map((tool) => tool.id));
      const nextDisabledTools = enabled
        ? disabledTools.filter((toolId) => !editableToolIds.has(toolId))
        : [
            ...disabledTools,
            ...editableTools.filter((tool) => !disabledToolSet.has(tool.id)).map((tool) => tool.id),
          ];
      void updatePolicy(enabled ? "enable-all" : "disable-all", {
        disabledTools: nextDisabledTools,
      });
    },
    [browserToolsEnabled, disabledToolSet, disabledTools, updatePolicy],
  );
  const handleEnableAll = useCallback(() => handleBulkChange(true), [handleBulkChange]);
  const handleDisableAll = useCallback(() => handleBulkChange(false), [handleBulkChange]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.tools.title", { name: providerLabel }),
      search: {
        onChange: setQuery,
        resetKey: providerId,
        placeholder: t("settings.providers.tools.searchPlaceholder"),
        autoFocus: true,
        testID: "paseo-tools-policy-search",
      },
    }),
    [providerId, providerLabel, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      testID="paseo-tools-policy-sheet"
      snapPoints={["70%", "92%"]}
    >
      {!globalToolsEnabled ? (
        <Alert
          variant="warning"
          title={t("settings.providers.tools.globalOverride.title")}
          description={t("settings.providers.tools.globalOverride.description")}
          testID="paseo-tools-global-override"
        />
      ) : null}
      {error ? (
        <Alert
          variant="error"
          title={t("settings.providers.tools.updateErrorTitle")}
          description={error}
          testID="paseo-tools-policy-error"
        />
      ) : null}
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.providers.tools.master.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("settings.providers.tools.master.hint")}</Text>
          </View>
          <Switch
            value={policy?.enabled !== false}
            onValueChange={handleMasterChange}
            disabled={controlsDisabled}
            accessibilityLabel={t("settings.providers.tools.master.accessibilityLabel", {
              name: providerLabel,
            })}
            testID="paseo-tools-master-switch"
          />
        </View>
      </View>
      <View style={styles.bulkActions}>
        <Button
          variant="outline"
          size="sm"
          onPress={handleEnableAll}
          disabled={controlsDisabled}
          testID="paseo-tools-enable-all"
        >
          {t("settings.providers.tools.enableAll")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={handleDisableAll}
          disabled={controlsDisabled}
          testID="paseo-tools-disable-all"
        >
          {t("settings.providers.tools.disableAll")}
        </Button>
      </View>
      {!browserToolsEnabled ? (
        <Alert
          variant="info"
          title={t("settings.providers.tools.browserUnavailable.title")}
          description={t("settings.providers.tools.browserUnavailable.description")}
          testID="paseo-tools-browser-unavailable"
        />
      ) : null}
      {visibleGroups.map((group) => (
        <View key={group.name} style={styles.group} testID={`paseo-tools-group-${group.name}`}>
          <Text style={styles.groupTitle} accessibilityRole="header">
            {group.name}
          </Text>
          <View style={settingsStyles.card}>
            {group.tools.map((tool, index) => (
              <PaseoToolRow
                key={tool.id}
                tool={tool}
                isEnabled={!disabledToolSet.has(tool.id)}
                disabled={controlsDisabled || (isBrowserTool(tool) && !browserToolsEnabled)}
                isFirst={index === 0}
                onChange={handleToolChange}
              />
            ))}
          </View>
        </View>
      ))}
      {visibleGroups.length === 0 ? (
        <Text style={styles.empty} testID="paseo-tools-empty">
          {t("settings.providers.tools.noSearchMatches")}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  bulkActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
  group: {
    gap: theme.spacing[2],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginLeft: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[6],
    textAlign: "center",
  },
}));
