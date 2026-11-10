import {
  BottomSheetBackdrop,
  useBottomSheet,
  useBottomSheetModal,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import type { SheetBackdropPress } from "./sheet-backdrop";

export type { SheetBackdropPress };

export function SheetBackdrop({
  pressBehavior,
  ...props
}: BottomSheetBackdropProps & { opacity?: number; pressBehavior: SheetBackdropPress }) {
  const { dismiss } = useBottomSheetModal();
  const { close } = useBottomSheet();
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    // A sheet that may veto its close slides itself down and lets its owner decide. The other
    // sheets ask the provider for the top modal, so a lower backdrop caught mid-transition still
    // dismisses the sheet the user sees.
    if (pressBehavior === "close") close();
    else dismiss();
  }, [close, dismiss, pressBehavior]);

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
        onPress={handlePress}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
