import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedInfo = withUnistyles(Info);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SettingsInfoTipProps {
  /** Header the tip belongs to; used for the accessibility label. */
  title: string;
  info: ReactNode;
  testID?: string;
}

/**
 * The one way a settings group or section explains itself: an info icon on the
 * header that opens a tooltip. Never a paragraph under the header — see
 * docs/design.md §7.
 */
export function SettingsInfoTip({ title, info, testID }: SettingsInfoTipProps) {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.groupInfo", { title })}
          testID={testID}
          hitSlop={8}
          style={styles.button}
        >
          <ThemedInfo size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" offset={8}>
        <Text style={styles.tooltipText}>{info}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    padding: theme.spacing[1],
    marginLeft: -theme.spacing[1],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    maxWidth: 280,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
