import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { CornerDownRight, Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { RecommendedPromptActions } from "@/response-control/recommended-prompt-actions";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedCornerDownRight = withUnistyles(CornerDownRight);
const ThemedPencil = withUnistyles(Pencil);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface RecommendedPromptsProps {
  prompts: readonly string[];
  actions: RecommendedPromptActions;
}

/**
 * Follow-up prompts the agent recommended in its response footer. Pressing a row
 * sends the prompt as-is; the pencil puts it in the composer instead. Only the
 * latest completed response renders these, so stale suggestions never get sent.
 */
export const RecommendedPrompts = memo(function RecommendedPrompts({
  prompts,
  actions,
}: RecommendedPromptsProps) {
  const uniquePrompts = useMemo(() => Array.from(new Set(prompts)), [prompts]);
  return (
    <View style={styles.list} testID="recommended-prompts">
      {uniquePrompts.map((prompt) => (
        <RecommendedPromptRow key={prompt} prompt={prompt} actions={actions} />
      ))}
    </View>
  );
});

const RecommendedPromptRow = memo(function RecommendedPromptRow({
  prompt,
  actions,
}: {
  prompt: string;
  actions: RecommendedPromptActions;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const showEdit = isHovered || isNative || isCompact;

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleSend = useCallback(async () => {
    if (isSending) return;
    setIsSending(true);
    try {
      await actions.send(prompt);
    } finally {
      setIsSending(false);
    }
  }, [actions, isSending, prompt]);
  const handleUseEdited = useCallback(() => {
    if (isSending) return;
    actions.useEdited(prompt);
  }, [actions, isSending, prompt]);

  const sendStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.send,
      isHovered || pressed ? styles.sendHighlighted : null,
      isSending ? styles.sendPending : null,
    ],
    [isHovered, isSending],
  );
  const editSlotStyle = useMemo(
    () => [styles.editSlot, showEdit ? null : styles.editSlotHidden],
    [showEdit],
  );
  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("responseControl.recommendedPrompts.useEdited")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  // Hover lives on a plain View; both Pressables sit inside it. See docs/hover.md.
  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="recommended-prompt"
    >
      <Pressable
        onPress={handleSend}
        disabled={isSending}
        style={sendStyle}
        accessibilityRole="button"
        accessibilityLabel={`${t("responseControl.recommendedPrompts.send")}: ${prompt}`}
        testID="recommended-prompt-send"
      >
        <ThemedCornerDownRight
          size={ICON_SIZE.sm}
          uniProps={isHovered ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={[styles.text, isHovered ? styles.textHighlighted : null]}>{prompt}</Text>
      </Pressable>
      <View style={editSlotStyle} pointerEvents={showEdit ? "auto" : "none"}>
        <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <View collapsable={false}>
              <Pressable
                onPress={handleUseEdited}
                disabled={isSending}
                style={styles.edit}
                accessibilityRole="button"
                accessibilityLabel={`${t("responseControl.recommendedPrompts.useEdited")}: ${prompt}`}
                testID="recommended-prompt-use-edited"
              >
                {({ hovered }) => (
                  <ThemedPencil
                    size={ICON_SIZE.sm}
                    uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
                  />
                )}
              </Pressable>
            </View>
          </TooltipTrigger>
          {tooltipContent}
        </Tooltip>
      </View>
    </View>
  );
});

const EDIT_SLOT_SIZE = 28;

const styles = StyleSheet.create((theme) => ({
  list: {
    alignSelf: "stretch",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
    marginLeft: -theme.spacing[1],
  },
  row: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    minHeight: EDIT_SLOT_SIZE,
  },
  send: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: EDIT_SLOT_SIZE,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sendHighlighted: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  sendPending: {
    opacity: theme.opacity[50],
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  textHighlighted: {
    color: theme.colors.foreground,
  },
  editSlot: {
    width: EDIT_SLOT_SIZE,
    height: EDIT_SLOT_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  editSlotHidden: {
    opacity: 0,
  },
  edit: {
    width: EDIT_SLOT_SIZE,
    height: EDIT_SLOT_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
