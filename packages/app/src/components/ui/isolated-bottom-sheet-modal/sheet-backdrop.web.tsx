import {
  BottomSheetBackdrop,
  useBottomSheetModal,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";

export function SheetBackdrop(props: BottomSheetBackdropProps & { opacity?: number }) {
  const { dismiss } = useBottomSheetModal();
  const { t } = useTranslation();
  const dismissTopSheet = useCallback(() => dismiss(), [dismiss]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="none"
        accessible={false}
        accessibilityRole={null}
        accessibilityLabel={null}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.bottomSheetBackdrop")}
        // The provider owns presentation order, including when a lower backdrop remounts.
        // Keep this target until the portal unmounts: animation must not expose the sheet below.
        onPress={dismissTopSheet}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
