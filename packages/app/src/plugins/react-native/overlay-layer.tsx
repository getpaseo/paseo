import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The inside of a plugin `Overlay` on every platform: a backdrop that asks to close, and a
 * full-window layer the plugin positions its own box or menu in.
 */
export function OverlayLayer({
  backdrop,
  onClose,
  children,
}: {
  backdrop: "dim" | "clear";
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Pressable
        testID="plugin-overlay-backdrop"
        accessibilityLabel={t("common.actions.dismiss")}
        focusable={false}
        style={backdrop === "dim" ? styles.scrim : styles.fill}
        onPress={onClose}
      />
      <View pointerEvents="box-none" style={styles.fill}>
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject },
  // The same dim as the host's own dialogs, so a plugin box reads as one of them.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
});
