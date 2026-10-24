import type { ManagedMcpService } from "@getpaseo/protocol/messages";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useToast } from "@/contexts/toast-api-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { openMcpServiceForm, type HeaderRow } from "./mcp-service-form-model";

export function McpServiceForm({
  service,
  save,
  cancel,
}: {
  service?: ManagedMcpService;
  save: (service: ManagedMcpService) => Promise<void>;
  cancel: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() => openMcpServiceForm(service));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  useEffect(() => () => model.close(), [model]);
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: save,
    onError: (error) => {
      toast.error(
        t(
          error.message.includes("MCP service name already exists")
            ? "mcp.nameExists"
            : "mcp.saveError",
        ),
      );
    },
  });
  const submit = useCallback(() => {
    const value = model.getSubmission();
    if (value && !mutation.isPending) mutation.mutate(value);
  }, [model, mutation]);
  const display = useMemo(() => ({ label: state.type }), [state.type]);
  const modeDisplay = useMemo(
    () => ({ label: state.mode === "json" ? "JSON" : t("mcp.formMode") }),
    [state.mode, t],
  );
  const modeOptions = useMemo(
    () => [
      { id: "form", value: "form" as const, label: t("mcp.formMode"), testID: "mcp-mode-form" },
      { id: "json", value: "json" as const, label: "JSON", testID: "mcp-mode-json" },
    ],
    [t],
  );
  const handlers = useMemo(
    () => ({
      json: (value: string) => model.setField("json", value),
      name: (value: string) => model.setField("name", value),
      command: (value: string) => model.setField("command", value),
      args: (value: string) => model.setField("args", value),
      env: (value: string) => model.setField("env", value),
      url: (value: string) => model.setField("url", value),
      type: (value: "stdio" | "http" | "sse") => model.setField("type", value),
    }),
    [model],
  );
  const close = useCallback(() => {
    if (!mutation.isPending) cancel();
  }, [cancel, mutation.isPending]);
  const header = useMemo(
    () => ({
      title: t(service ? "mcp.edit" : "mcp.add"),
      actions: (
        <SettingsInfoTip
          title={t(service ? "mcp.edit" : "mcp.add")}
          info={t("mcp.invalid")}
          testID="mcp-form-tip"
        />
      ),
    }),
    [service, t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" size={size} onPress={cancel} disabled={mutation.isPending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size={size}
          onPress={submit}
          disabled={!state.canSubmit || mutation.isPending}
          testID="mcp-save"
        >
          {t(mutation.isPending ? "mcp.saving" : "common.actions.save")}
        </Button>
      </View>
    ),
    [cancel, mutation.isPending, size, state.canSubmit, submit, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      testID="mcp-service-dialog"
      footer={footer}
    >
      <View style={styles.form} testID="mcp-service-form">
        <Field label={t("mcp.name")}>
          <FormTextInput
            size={size}
            initialValue={state.name}
            onChangeText={handlers.name}
            accessibilityLabel={t("mcp.name")}
            testID="mcp-name"
            editable={!mutation.isPending}
          />
        </Field>
        <SelectField
          label={t("mcp.editorMode")}
          value={state.mode}
          selectedDisplay={modeDisplay}
          options={modeOptions}
          onChange={model.setMode}
          placeholder={t("mcp.editorMode")}
          emptyText=""
          searchable={false}
          size={size}
          disabled={mutation.isPending}
          triggerTestID="mcp-mode-trigger"
        />
        {state.mode === "json" ? (
          <Field label={t("mcp.jsonConfig")}>
            <FormTextInput
              size={size}
              initialValue={state.json}
              onChangeText={handlers.json}
              accessibilityLabel={t("mcp.jsonConfig")}
              testID="mcp-json"
              style={styles.json}
              editable={!mutation.isPending}
              multiline
              numberOfLines={10}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        ) : (
          <>
            <SelectField
              label={t("mcp.transport")}
              value={state.type}
              selectedDisplay={display}
              options={TRANSPORT_OPTIONS}
              onChange={handlers.type}
              placeholder={t("mcp.transport")}
              emptyText=""
              size={size}
              disabled={mutation.isPending}
              testID="mcp-transport"
              triggerTestID="mcp-transport-trigger"
            />
            {state.type === "stdio" ? (
              <>
                <Field label={t("mcp.command")}>
                  <FormTextInput
                    size={size}
                    initialValue={state.command}
                    onChangeText={handlers.command}
                    accessibilityLabel={t("mcp.command")}
                    testID="mcp-command"
                    editable={!mutation.isPending}
                  />
                </Field>
                <Field label={t("mcp.args")}>
                  <FormTextInput
                    size={size}
                    initialValue={state.args}
                    onChangeText={handlers.args}
                    accessibilityLabel={t("mcp.args")}
                    testID="mcp-args"
                    editable={!mutation.isPending}
                  />
                </Field>
                <Field label={t("mcp.env")}>
                  <FormTextInput
                    size={size}
                    initialValue={state.env}
                    onChangeText={handlers.env}
                    accessibilityLabel={t("mcp.env")}
                    testID="mcp-env"
                    editable={!mutation.isPending}
                    secureTextEntry
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <FormTextInput
                    size={size}
                    initialValue={state.url}
                    onChangeText={handlers.url}
                    accessibilityLabel="URL"
                    testID="mcp-url"
                    editable={!mutation.isPending}
                  />
                </Field>
                <Field
                  label={t("mcp.headers")}
                  error={state.headerError ? t("mcp.headerError") : undefined}
                >
                  <View style={styles.headers}>
                    {state.headers?.map((row) => (
                      <McpHeaderRow
                        key={row.id}
                        row={row}
                        model={model}
                        disabled={mutation.isPending}
                        size={size}
                      />
                    ))}
                    <Button
                      variant="ghost"
                      size={size}
                      onPress={model.addHeader}
                      disabled={mutation.isPending}
                      testID="mcp-header-add"
                    >
                      {t("mcp.addHeader")}
                    </Button>
                  </View>
                </Field>
              </>
            )}
          </>
        )}
        {state.modeError ? <Alert title={t("mcp.modeError")} /> : null}
        {state.mode === "json" && !state.canSubmit ? <Alert title={t("mcp.invalidJson")} /> : null}
      </View>
    </AdaptiveModalSheet>
  );
}
function McpHeaderRow({
  row,
  model,
  disabled,
  size,
}: {
  row: HeaderRow;
  model: ReturnType<typeof openMcpServiceForm>;
  disabled: boolean;
  size: "sm" | "md";
}) {
  const { t } = useTranslation();
  const setKey = useCallback(
    (value: string) => model.updateHeader(row.id, "key", value),
    [model, row.id],
  );
  const setValue = useCallback(
    (value: string) => model.updateHeader(row.id, "value", value),
    [model, row.id],
  );
  const remove = useCallback(() => model.removeHeader(row.id), [model, row.id]);
  return (
    <View style={size === "md" ? styles.headerRowCompact : styles.headerRow}>
      <FormTextInput
        style={size === "md" ? undefined : styles.headerInput}
        size={size}
        initialValue={row.key}
        onChangeText={setKey}
        placeholder={t("mcp.headerKey")}
        accessibilityLabel={t("mcp.headerKey")}
        testID="mcp-header-key"
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FormTextInput
        style={size === "md" ? undefined : styles.headerInput}
        size={size}
        initialValue={row.value}
        onChangeText={setValue}
        placeholder={t("mcp.headerValue")}
        accessibilityLabel={t("mcp.headerValue")}
        testID="mcp-header-value"
        editable={!disabled}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button
        variant="ghost"
        size={size}
        onPress={remove}
        disabled={disabled}
        testID="mcp-header-remove"
      >
        {t("mcp.delete")}
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  headers: { gap: theme.spacing[2] },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  headerInput: { flex: 1, minWidth: 0, width: 0 },
  headerRowCompact: { gap: theme.spacing[2] },
  form: { gap: theme.spacing[4] },
  json: { fontFamily: theme.fontFamily.mono, minHeight: 220 },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));

const TRANSPORT_OPTIONS = (["stdio", "http", "sse"] as const).map((type) => ({
  id: type,
  value: type,
  label: { stdio: "stdio", http: "HTTP", sse: "SSE" }[type],
}));
