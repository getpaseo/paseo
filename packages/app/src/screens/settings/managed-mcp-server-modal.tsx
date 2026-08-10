import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  buildManagedMcpServerPatch,
  createManagedMcpSecretRow,
  type ManagedMcpSecretRow,
  type ManagedMcpSecretSource,
  type ManagedMcpServerFormState,
  type ManagedMcpTransport,
} from "./managed-mcp-server-form";
import type { ManagedMcpServerPatch } from "@getpaseo/protocol/messages";

interface ManagedMcpServerModalProps {
  mode: "add" | "edit";
  initialState: ManagedMcpServerFormState;
  onClose: () => void;
  onSave: (name: string, server: ManagedMcpServerPatch) => Promise<void>;
}

const TRANSPORT_OPTIONS = [
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "stdio" },
] satisfies Array<{ value: ManagedMcpTransport; label: string }>;

export function ManagedMcpServerModal({
  mode,
  initialState,
  onClose,
  onSave,
}: ManagedMcpServerModalProps) {
  const isCompact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const [state, setState] = useState(initialState);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "add"
          ? t("settings.host.orchestration.managedMcp.addTitle")
          : t("settings.host.orchestration.managedMcp.editTitle", { name: initialState.name }),
    }),
    [initialState.name, mode, t],
  );
  const controlSize = isCompact ? "md" : "sm";

  const updateState = useCallback(
    <K extends keyof ManagedMcpServerFormState>(key: K, value: ManagedMcpServerFormState[K]) => {
      setState((current) => ({ ...current, [key]: value }));
      setError(null);
    },
    [],
  );
  const handleNameChange = useCallback(
    (value: string) => updateState("name", value),
    [updateState],
  );
  const handleTransportChange = useCallback(
    (value: ManagedMcpTransport) => updateState("transport", value),
    [updateState],
  );
  const handleTargetChange = useCallback(
    (value: string) => updateState("target", value),
    [updateState],
  );
  const handleArgsChange = useCallback(
    (value: string) => updateState("args", value),
    [updateState],
  );
  const handleAlwaysLoadChange = useCallback(
    (value: boolean) => updateState("alwaysLoad", value),
    [updateState],
  );

  const updateSecret = useCallback((id: string, patch: Partial<ManagedMcpSecretRow>) => {
    setState((current) => ({
      ...current,
      secrets: current.secrets.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
    setError(null);
  }, []);

  const handleAddSecret = useCallback(() => {
    setState((current) => ({
      ...current,
      secrets: [...current.secrets, createManagedMcpSecretRow()],
    }));
  }, []);

  const handleRemoveSecret = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      secrets: current.secrets.filter((row) => row.id !== id),
    }));
  }, []);

  const handleSave = useCallback(async () => {
    if (isPending) return;
    setError(null);
    try {
      const result = buildManagedMcpServerPatch(state);
      setIsPending(true);
      await onSave(result.name, result.server);
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.host.orchestration.managedMcp.saveFailed"),
      );
    } finally {
      setIsPending(false);
    }
  }, [isPending, onClose, onSave, state, t]);

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      desktopMaxWidth={560}
      testID="managed-mcp-server-modal"
    >
      <View style={styles.body}>
        <Field label={t("settings.host.orchestration.managedMcp.serverName")}>
          <FormTextInput
            initialValue={initialState.name}
            resetKey={initialState.name}
            onChangeText={handleNameChange}
            editable={!isPending && mode === "add"}
            autoCapitalize="none"
            autoCorrect={false}
            size={controlSize}
            testID="managed-mcp-name-input"
          />
        </Field>

        <Field label={t("settings.host.orchestration.managedMcp.transport")}>
          <SegmentedControl
            options={TRANSPORT_OPTIONS}
            value={state.transport}
            onValueChange={handleTransportChange}
            size={controlSize}
            testID="managed-mcp-transport"
          />
        </Field>

        <Field
          label={t(
            state.transport === "stdio"
              ? "settings.host.orchestration.managedMcp.command"
              : "settings.host.orchestration.managedMcp.url",
          )}
        >
          <FormTextInput
            initialValue={initialState.target}
            resetKey={`${initialState.name}-target`}
            onChangeText={handleTargetChange}
            editable={!isPending}
            autoCapitalize="none"
            autoCorrect={false}
            size={controlSize}
            testID="managed-mcp-target-input"
          />
        </Field>

        {state.transport === "stdio" ? (
          <Field
            label={t("settings.host.orchestration.managedMcp.arguments")}
            hint={t("settings.host.orchestration.managedMcp.argumentsHint")}
          >
            <FormTextInput
              initialValue={initialState.args}
              resetKey={`${initialState.name}-args`}
              onChangeText={handleArgsChange}
              editable={!isPending}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              size={controlSize}
              testID="managed-mcp-args-input"
            />
          </Field>
        ) : null}

        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.rowTitle}>
              {t("settings.host.orchestration.managedMcp.alwaysLoad")}
            </Text>
            <Text style={styles.rowHint}>
              {t("settings.host.orchestration.managedMcp.alwaysLoadHint")}
            </Text>
          </View>
          <Switch
            value={state.alwaysLoad}
            onValueChange={handleAlwaysLoadChange}
            disabled={isPending}
            accessibilityLabel={t("settings.host.orchestration.managedMcp.alwaysLoadAccessibility")}
          />
        </View>

        <View style={styles.secretHeader}>
          <View style={styles.switchText}>
            <Text style={styles.rowTitle}>
              {t(
                state.transport === "stdio"
                  ? "settings.host.orchestration.managedMcp.environmentVariables"
                  : "settings.host.orchestration.managedMcp.requestHeaders",
              )}
            </Text>
            <Text style={styles.rowHint}>
              {t("settings.host.orchestration.managedMcp.secretHint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleAddSecret}
            disabled={isPending}
            testID="managed-mcp-add-secret"
          >
            {t("settings.host.orchestration.managedMcp.add")}
          </Button>
        </View>

        {state.secrets.map((row) => (
          <ManagedMcpSecretEditorRow
            key={row.id}
            row={row}
            transport={state.transport}
            controlSize={controlSize}
            isPending={isPending}
            onChange={updateSecret}
            onRemove={handleRemoveSecret}
          />
        ))}

        {error ? (
          <Alert variant="error" description={error} testID="managed-mcp-save-error" />
        ) : null}

        <View style={styles.actions}>
          <Button variant="secondary" onPress={onClose} disabled={isPending} style={styles.action}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSave}
            loading={isPending}
            disabled={isPending}
            style={styles.action}
            testID="managed-mcp-save"
          >
            {t("settings.host.orchestration.managedMcp.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

interface ManagedMcpSecretEditorRowProps {
  row: ManagedMcpSecretRow;
  transport: ManagedMcpTransport;
  controlSize: "sm" | "md";
  isPending: boolean;
  onChange: (id: string, patch: Partial<ManagedMcpSecretRow>) => void;
  onRemove: (id: string) => void;
}

function ManagedMcpSecretEditorRow({
  row,
  transport,
  controlSize,
  isPending,
  onChange,
  onRemove,
}: ManagedMcpSecretEditorRowProps) {
  const { t } = useTranslation();
  const sourceOptions = useMemo(
    () =>
      [
        {
          value: "value",
          label: t("settings.host.orchestration.managedMcp.directValue"),
        },
        {
          value: "env",
          label: t("settings.host.orchestration.managedMcp.environmentSource"),
        },
      ] satisfies Array<{ value: ManagedMcpSecretSource; label: string }>,
    [t],
  );
  const handleKeyChange = useCallback(
    (value: string) => onChange(row.id, { key: value }),
    [onChange, row.id],
  );
  const handleSourceChange = useCallback(
    (source: ManagedMcpSecretSource) =>
      onChange(row.id, { source, value: "", preserveExisting: false }),
    [onChange, row.id],
  );
  const handleValueChange = useCallback(
    (value: string) => onChange(row.id, { value }),
    [onChange, row.id],
  );
  const handleRemove = useCallback(() => onRemove(row.id), [onRemove, row.id]);

  return (
    <View style={styles.secretCard} testID={`managed-mcp-secret-${row.id}`}>
      <Field
        label={t(
          transport === "stdio"
            ? "settings.host.orchestration.managedMcp.variable"
            : "settings.host.orchestration.managedMcp.header",
        )}
      >
        <FormTextInput
          initialValue={row.key}
          resetKey={`${row.id}-key`}
          onChangeText={handleKeyChange}
          editable={!isPending}
          autoCapitalize="none"
          autoCorrect={false}
          size={controlSize}
        />
      </Field>
      <SegmentedControl
        options={sourceOptions}
        value={row.source}
        onValueChange={handleSourceChange}
        size={controlSize}
      />
      <Field
        label={t(
          row.source === "env"
            ? "settings.host.orchestration.managedMcp.environmentVariableName"
            : "settings.host.orchestration.managedMcp.value",
        )}
        hint={
          row.source === "value" && row.preserveExisting
            ? t("settings.host.orchestration.managedMcp.keepValueHint")
            : undefined
        }
      >
        <FormTextInput
          initialValue={row.value}
          resetKey={`${row.id}-value`}
          onChangeText={handleValueChange}
          editable={!isPending}
          secureTextEntry={row.source === "value"}
          autoCapitalize="none"
          autoCorrect={false}
          size={controlSize}
        />
      </Field>
      <Button variant="ghost" size="sm" onPress={handleRemove} disabled={isPending}>
        {t("settings.host.orchestration.managedMcp.remove")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  switchText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  secretHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  secretCard: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  action: {
    flex: 1,
  },
}));
