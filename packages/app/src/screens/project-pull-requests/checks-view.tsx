import { useCallback, useMemo } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { Check, X, Clock, CircleSlash, Minus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/utils/open-external-url";
import { useToast } from "@/contexts/toast-context";
import { checkLabel, getCheckIndicators } from "./checks";

const ICONS = {
  passed: withUnistyles(Check),
  failure: withUnistyles(X),
  pending: withUnistyles(Clock),
  cancelled: withUnistyles(CircleSlash),
  skipped: withUnistyles(Minus),
};
type IndicatorStatus = keyof typeof ICONS;
const COLORS = {
  passed: (theme: Theme) => ({ color: theme.colors.statusSuccess }),
  failure: (theme: Theme) => ({ color: theme.colors.statusDanger }),
  pending: (theme: Theme) => ({ color: theme.colors.statusWarning }),
  cancelled: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
  skipped: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
};

export function PullRequestChecks({ item }: { item: ForgeSearchItem }) {
  const { t } = useTranslation();
  const { failures, cancelled, summary } = getCheckIndicators(item.checks);
  return (
    <View style={styles.indicators} testID={`project-pr-checks-${item.number}`}>
      {summary ? (
        <CheckStatusButton
          status={summary}
          label={t(`projectPullRequests.checks.${summary}`)}
          url={item.url}
        />
      ) : null}
      {failures.map((check) => (
        <CheckStatusButton
          key={`${check.name}:${check.url}`}
          status="failure"
          label={checkLabel(check)}
          url={check.url ?? item.url}
        />
      ))}
      {cancelled.map((check) => (
        <CheckStatusButton
          key={`${check.name}:${check.url}`}
          status="cancelled"
          label={checkLabel(check)}
          url={check.url ?? item.url}
        />
      ))}
    </View>
  );
}

function CheckStatusButton({
  status,
  label,
  url,
}: {
  status: IndicatorStatus;
  label: string;
  url: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const onPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(url).catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : t("common.errors.error")),
      );
    },
    [url, toast, t],
  );
  const icon = useMemo(() => {
    const Icon = ICONS[status];
    return <Icon size={16} uniProps={COLORS[status]} />;
  }, [status]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={icon}
          onPress={onPress}
          accessibilityLabel={label}
          testID={`project-pr-check-${status}`}
        />
      </TooltipTrigger>
      <TooltipContent testID="project-pr-check-tooltip">
        <Text style={styles.tooltip}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}
const styles = StyleSheet.create((theme) => ({
  indicators: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
