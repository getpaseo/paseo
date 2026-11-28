import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { DismissToast } from "@/components/toast-host";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { toggleShownModel } from "./shown-models";

const RESET_UNDO_WINDOW_MS = 6000;

export interface ShownModelsEditor {
  /** The models pickers show first, including a change still being saved. */
  shownModels: readonly string[];
  toggle: (modelId: string) => void;
  reset: () => void;
  /** Changes when the list is replaced as a whole (reset, undo), so the page can re-sort it. */
  revision: number;
}

/**
 * Edits one provider's shown models. A check shows at once and is saved in the background; a
 * failed save puts the last saved list back and says so. Reset can be undone from its toast.
 */
export function useShownModelsEditor(input: {
  provider: string;
  config: MutableDaemonConfig | null;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
}): ShownModelsEditor {
  const { provider, config, patchConfig } = input;
  const { t } = useTranslation();
  const toast = useToast();
  // The list being saved. Each save sends the whole list, so the latest one wins.
  const [pending, setPending] = useState<readonly string[] | null>(null);
  const [revision, setRevision] = useState(0);
  const saved = config?.providers?.[provider]?.shownModels;
  const shownModels = useMemo(() => pending ?? saved ?? [], [pending, saved]);

  const save = useCallback(
    (next: readonly string[]) => {
      setPending(next);
      const settle = () => setPending((current) => (current === next ? null : current));
      void patchConfig({ providers: { [provider]: { shownModels: [...next] } } }).then(
        settle,
        (error: unknown) => {
          settle();
          toast.error(
            error instanceof Error && error.message
              ? error.message
              : t("settings.providers.models.failedToSaveShown"),
          );
        },
      );
    },
    [patchConfig, provider, t, toast],
  );

  const toggle = useCallback(
    (modelId: string) => save(toggleShownModel(shownModels, modelId)),
    [save, shownModels],
  );

  const dismissResetToast = useRef<DismissToast>(() => {});
  const restore = useCallback(
    (previous: readonly string[]) => {
      dismissResetToast.current();
      save(previous);
      setRevision((value) => value + 1);
    },
    [save],
  );

  const reset = useCallback(() => {
    save([]);
    setRevision((value) => value + 1);
    dismissResetToast.current = toast.show(
      <ShownResetToast previous={shownModels} onUndo={restore} />,
      { layout: "action", durationMs: RESET_UNDO_WINDOW_MS, testID: "provider-shown-reset-toast" },
    );
  }, [restore, save, shownModels, toast]);

  return { shownModels, toggle, reset, revision };
}

function ShownResetToast(props: {
  previous: readonly string[];
  onUndo: (previous: readonly string[]) => void;
}) {
  const { previous, onUndo } = props;
  const { t } = useTranslation();
  const undo = useCallback(() => onUndo(previous), [onUndo, previous]);
  return (
    <View style={styles.row}>
      <Text style={styles.message}>{t("settings.providers.models.shownReset")}</Text>
      <Button size="sm" onPress={undo} testID="provider-shown-reset-undo">
        {t("modelSelector.undo")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
