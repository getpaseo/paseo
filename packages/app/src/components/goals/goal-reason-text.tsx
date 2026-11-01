import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { reasonPreview } from "@/goals/goal-recovery";
import { settingsStyles } from "@/styles/settings";

/**
 * A reason as one line, with More to read all of it. The full text is the goal's own record
 * (a Lead's reason, a failure), so it is shown as written and can be selected.
 */
export function GoalReasonText({ text, testID }: { text: string; testID?: string }): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const { full, summary, canExpand } = reasonPreview(text);
  return (
    <View style={styles.container} testID={testID}>
      <Text
        style={settingsStyles.rowHint}
        numberOfLines={canExpand && !expanded ? 2 : undefined}
        selectable={expanded}
      >
        {expanded ? full : summary}
      </Text>
      {canExpand ? (
        <View style={styles.toggleRow}>
          <Button
            variant="ghost"
            size="xs"
            onPress={toggle}
            accessibilityState={expandedState}
            testID={testID ? `${testID}-toggle` : undefined}
          >
            {expanded ? t("goals.failure.less") : t("goals.failure.more")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  toggleRow: {
    flexDirection: "row",
  },
}));
