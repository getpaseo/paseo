import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopImportOutput } from "@/desktop/host";

type ImportState =
  | { status: "confirm" }
  | { status: "running"; runId: string | null; output: string }
  | { status: "complete"; succeeded: boolean; output: string }
  | { status: "failed"; message: string; output: string };

export interface ImportSourceDescriptor {
  id: string;
  icon: ImageSourcePropType;
  title: string;
}

export function useImportAvailability(source: string) {
  const { t } = useTranslation();
  const [availability, setAvailability] = useState<{
    available: boolean;
    reason: string | null;
  }>({
    available: false,
    reason: t("desktop.integrations.import.availability.checking"),
  });
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    async function loadAvailability() {
      const next = await getDesktopHost()?.imports?.getAvailability?.({ source });
      if (active && next) {
        setAvailability({
          available: next.available,
          reason: next.reason ? t(`desktop.integrations.import.availability.${next.reason}`) : null,
        });
        if (next.reason === "host-not-running") {
          retry = setTimeout(() => void loadAvailability(), 2_000);
        }
      }
    }
    void loadAvailability();
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
    };
  }, [source, t]);
  return {
    ...availability,
    visible,
    open: () => setVisible(true),
    close: () => setVisible(false),
  };
}

export function ImportSheet({
  source,
  visible,
  onClose,
}: {
  source: ImportSourceDescriptor;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ImportState>({ status: "confirm" });
  const header = useMemo<SheetHeader>(
    () => ({ title: t("desktop.integrations.import.sheetTitle", { source: source.title }) }),
    [source.title, t],
  );
  const close = useCallback(() => {
    if (state.status !== "running") onClose();
  }, [onClose, state.status]);

  useEffect(() => {
    if (!visible) setState({ status: "confirm" });
  }, [visible]);

  const start = useCallback(async () => {
    const bridge = getDesktopHost()?.imports;
    if (!bridge?.run || !bridge.onOutput) {
      setState({
        status: "failed",
        message: t("desktop.integrations.import.unavailable"),
        output: "",
      });
      return;
    }
    setState({ status: "running", runId: null, output: "" });
    let runId: string | null = null;
    const unsubscribe = bridge.onOutput((event: DesktopImportOutput) => {
      if (runId && event.runId !== runId) return;
      setState((current) => reduceOutput(current, event));
      if (event.type === "status") unsubscribe();
    });
    try {
      const started = await bridge.run({ source: source.id });
      runId = started.runId;
      setState((current) =>
        current.status === "running" ? { ...current, runId: started.runId } : current,
      );
    } catch (error) {
      unsubscribe();
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        output: "",
      });
    }
  }, [source.id, t]);

  const footer = useMemo(() => {
    if (state.status === "confirm") {
      return (
        <Button onPress={start} testID="import-confirm">
          {t("desktop.integrations.import.actions.import")}
        </Button>
      );
    }
    if (state.status === "running") {
      return <Button disabled>{t("desktop.integrations.import.actions.importing")}</Button>;
    }
    return (
      <Button onPress={close} testID="import-done">
        {t("desktop.integrations.import.actions.done")}
      </Button>
    );
  }, [close, start, state.status, t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      footer={footer}
      desktopMaxWidth={640}
      testID="import-sheet"
      dismissible={state.status !== "running"}
    >
      {state.status === "confirm" ? (
        <Text style={styles.copy}>
          {t("desktop.integrations.import.confirmation", { source: source.title })}
        </Text>
      ) : (
        <View style={styles.content}>
          {state.status === "complete" ? (
            <Text testID="import-result" style={styles.copy}>
              {state.succeeded
                ? t("desktop.integrations.import.complete")
                : t("desktop.integrations.import.failed")}
            </Text>
          ) : null}
          {state.status === "failed" ? (
            <Text testID="import-error" style={styles.error}>
              {state.message}
            </Text>
          ) : null}
          <ScrollView style={styles.output}>
            <Text selectable testID="import-output" style={styles.outputText}>
              {state.output}
            </Text>
          </ScrollView>
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function reduceOutput(state: ImportState, event: DesktopImportOutput): ImportState {
  if (state.status !== "running") return state;
  if (event.type === "status") {
    return { status: "complete", succeeded: event.succeeded, output: state.output };
  }
  const line = `${event.event.level.toUpperCase()}: ${event.event.message}\n`;
  return { ...state, output: `${state.output}${line}` };
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3] },
  copy: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  output: {
    minHeight: 180,
    maxHeight: 360,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  outputText: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12 },
}));
