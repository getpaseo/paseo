import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { resolveButtonLabels } from "@/utils/confirm-dialog";
import { useConfirmDialogStore } from "@/utils/confirm-dialog-store";

/** Shows the browser confirm dialog that confirmDialog() is waiting on. Mount once at the app root. */
export function ConfirmDialogHost() {
  const pending = useConfirmDialogStore((state) => state.pending);
  const answer = useConfirmDialogStore((state) => state.answer);

  const pendingId = pending?.id;
  // Bound to the request on screen, so a sheet still closing after a replacement
  // cannot answer the newer request.
  const cancel = useCallback(() => {
    if (pendingId !== undefined) answer(pendingId, false);
  }, [answer, pendingId]);
  const confirm = useCallback(() => {
    if (pendingId !== undefined) answer(pendingId, true);
  }, [answer, pendingId]);
  const title = pending?.input.title ?? "";
  const header = useMemo<SheetHeader>(() => ({ title }), [title]);

  if (!pending) return null;
  const { input } = pending;
  const labels = resolveButtonLabels(input);

  return (
    <AdaptiveModalSheet
      key={pending.id}
      header={header}
      visible
      onClose={cancel}
      testID="confirm-dialog"
    >
      <Text style={styles.message} testID="confirm-dialog-message">
        {input.message}
      </Text>
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          style={FLEX_1_STYLE}
          onPress={cancel}
          testID="confirm-dialog-cancel"
        >
          {labels.cancelLabel}
        </Button>
        <Button
          variant={input.destructive ? "destructive" : "default"}
          size="sm"
          style={FLEX_1_STYLE}
          onPress={confirm}
          testID="confirm-dialog-confirm"
        >
          {labels.confirmLabel}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

const FLEX_1_STYLE = { flex: 1 };
