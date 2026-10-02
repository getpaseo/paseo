import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { PluginExecutionPresetCatalog } from "@getpaseo/plugin/client";
import { DraftAgentControls, type DraftAgentControlsProps } from "@/composer/agent-controls";
import { useInstalledPlugins } from "./registry";
import { getExecutionModes } from "./execution";
import { ExecutionControls } from "./execution-controls";

const rowStyle = { flexDirection: "row", flexWrap: "wrap", alignItems: "center" } as const;

export function useExecutionMode({
  serverId,
  cwd,
  projectId,
  initialExecutionId,
  initialPresetId,
}: {
  serverId: string;
  cwd: string | null;
  projectId?: string;
  initialExecutionId?: string;
  initialPresetId?: string;
}) {
  const plugins = useInstalledPlugins();
  const modes = useMemo(() => getExecutionModes(plugins, serverId), [plugins, serverId]);
  const [executionId, setExecutionId] = useState(initialExecutionId ?? "");
  const [presetId, setPresetId] = useState(initialPresetId ?? "");
  const selectionScope = useRef<string | null>(null);
  const explicitPreset = useRef(initialPresetId);
  const [presetCatalog, setPresetCatalog] = useState<PluginExecutionPresetCatalog | null>(null);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const selectedExecution = useMemo(
    () => modes.find((mode) => mode.id === executionId),
    [modes, executionId],
  );
  useEffect(() => {
    let active = true;
    setPresetCatalog(null);
    setExecutionError(null);
    if (!executionId || !cwd) {
      setPresetsLoading(false);
      return;
    }
    if (!selectedExecution) {
      setPresetsLoading(false);
      setExecutionError(
        "Execution mode unavailable on this host. Enable the plugin or choose Direct.",
      );
      return;
    }
    const scope = `${serverId}:${executionId}:${cwd}:${projectId ?? ""}`;
    if (selectionScope.current !== null && selectionScope.current !== scope)
      explicitPreset.current = undefined;
    selectionScope.current = scope;
    setPresetsLoading(true);
    const load = async () => {
      try {
        const catalog = await selectedExecution.contribution.loadPresets({ cwd, projectId });
        if (!active) return;
        setPresetCatalog(catalog);
        const requested = explicitPreset.current;
        setPresetId(requested ?? catalog.defaultPresetId ?? "");
      } catch (error) {
        if (active) setExecutionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setPresetsLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [executionId, selectedExecution, cwd, projectId, serverId]);
  const handleExecutionChange = useCallback((id: string) => {
    explicitPreset.current = undefined;
    setExecutionId(id);
    setPresetId("");
  }, []);
  const handlePresetChange = useCallback((id: string) => {
    explicitPreset.current = id;
    setPresetId(id);
  }, []);
  return useMemo(
    () => ({
      modes,
      executionId,
      presetId,
      presetCatalog,
      presetsLoading,
      executionError,
      selectedExecution,
      placeholder: selectedExecution?.contribution.placeholder,
      handleExecutionChange,
      setPresetId: handlePresetChange,
    }),
    [
      modes,
      executionId,
      presetId,
      presetCatalog,
      presetsLoading,
      executionError,
      selectedExecution,
      handleExecutionChange,
      handlePresetChange,
    ],
  );
}

export function buildExecutionControls(
  execution: ReturnType<typeof useExecutionMode>,
  agentControls: DraftAgentControlsProps | undefined,
  disabled: boolean,
  compact: boolean,
) {
  if (!execution.modes.length && !execution.executionId) return undefined;
  return (
    <View style={rowStyle}>
      <ExecutionControls
        modes={execution.modes}
        executionId={execution.executionId}
        onExecutionChange={execution.handleExecutionChange}
        catalog={execution.presetCatalog}
        presetId={execution.presetId}
        onPresetChange={execution.setPresetId}
        loading={execution.presetsLoading}
        error={execution.executionError}
        disabled={disabled}
        onManage={execution.selectedExecution?.contribution.onManage}
      />
      {!execution.executionId && agentControls ? (
        <DraftAgentControls {...agentControls} isCompactLayout={compact} />
      ) : null}
    </View>
  );
}
