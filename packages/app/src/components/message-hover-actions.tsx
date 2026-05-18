import { memo, useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy, RefreshCw } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ThemedCopy = withUnistyles(Copy);
const ThemedRefreshCw = withUnistyles(RefreshCw);

const foregroundMutedMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

interface MessageHoverActionsProps {
  children: ReactNode;
  messageText?: string;
  showRetry?: boolean;
  onRetry?: () => void;
}

export const MessageHoverActions = memo(function MessageHoverActions({
  children,
  messageText,
  showRetry = false,
  onRetry,
}: MessageHoverActionsProps) {
  const isMobile = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const handleCopy = useCallback(async () => {
    if (messageText) {
      await Clipboard.setStringAsync(messageText);
    }
  }, [messageText]);

  if (isMobile) {
    // oxlint-disable-next-line react/jsx-no-useless-fragment
    return <>{children}</>;
  }

  return (
    <View
      onPointerEnter={handleHoverIn}
      onPointerLeave={handleHoverOut}
      style={hoverStyles.wrapper}
    >
      {children}
      {isHovered && (
        <View style={hoverStyles.actionsBar}>
          {messageText && (
            <Tooltip>
              <TooltipTrigger>
                <HoverActionButton onPress={handleCopy}>
                  <ThemedCopy size={14} uniProps={foregroundMutedMapping} />
                </HoverActionButton>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          )}
          {showRetry && onRetry && (
            <Tooltip>
              <TooltipTrigger>
                <HoverActionButton onPress={onRetry}>
                  <ThemedRefreshCw size={14} uniProps={foregroundMutedMapping} />
                </HoverActionButton>
              </TooltipTrigger>
              <TooltipContent>Retry</TooltipContent>
            </Tooltip>
          )}
        </View>
      )}
    </View>
  );
});

const hoverActionButtonStyle = ({ pressed }: { pressed: boolean }) => [
  hoverStyles.actionButton,
  pressed && hoverStyles.actionButtonPressed,
];

function HoverActionButton({ children, onPress }: { children: ReactNode; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={hoverActionButtonStyle}>
      {children}
    </Pressable>
  );
}

const hoverStyles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "relative" as const,
  },
  actionsBar: {
    position: "absolute" as const,
    top: -4,
    right: 0,
    flexDirection: "row" as const,
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[1],
    ...theme.shadow.sm,
    zIndex: 10,
  },
  actionButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  actionButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
}));
