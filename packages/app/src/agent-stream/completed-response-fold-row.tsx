import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { CompletedResponseFold } from "./completed-response-fold";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const foldButtonStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  stylesheet.button,
  hovered ? stylesheet.buttonHovered : null,
  pressed ? stylesheet.buttonPressed : null,
];

export const CompletedResponseFoldRow = memo(function CompletedResponseFoldRow({
  fold,
  onToggle,
  children,
}: {
  fold: CompletedResponseFold;
  onToggle: (responseId: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onToggle(fold.responseId), [fold.responseId, onToggle]);
  const label = fold.expanded
    ? t("agentStream.completedResponse.hideWork")
    : t("agentStream.completedResponse.showWork");
  const accessibilityState = useMemo(() => ({ expanded: fold.expanded }), [fold.expanded]);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={handlePress}
        style={foldButtonStyle}
        testID={`completed-response-fold-${fold.responseId}`}
      >
        {fold.expanded ? (
          <ThemedChevronDown size={14} strokeWidth={2} uniProps={iconColorMapping} />
        ) : (
          <ThemedChevronRight size={14} strokeWidth={2} uniProps={iconColorMapping} />
        )}
        <Text style={stylesheet.label}>{label}</Text>
      </Pressable>
      {children}
    </>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  button: {
    minHeight: 44,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.spacing[2],
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
