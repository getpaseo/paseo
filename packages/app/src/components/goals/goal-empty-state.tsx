import { useCallback, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { GOAL_TEMPLATES, type GoalTemplate } from "@/goals/goal-templates";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** First run: what a goal is, one button to start, and templates that fill the form. */
export function GoalEmptyState({
  onCreate,
  onTemplate,
}: {
  onCreate: () => void;
  onTemplate: (template: GoalTemplate) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View testID="goals-empty">
      <View style={styles.hero}>
        <Text style={styles.title}>{t("goals.empty")}</Text>
        <Text style={styles.description}>{t("goals.emptyDescription")}</Text>
        <Button variant="default" leftIcon={Plus} onPress={onCreate} testID="goals-create-first">
          {t("goals.createFirst")}
        </Button>
      </View>
      <GoalTemplateList onTemplate={onTemplate} />
    </View>
  );
}

export function GoalTemplateList({
  onTemplate,
}: {
  onTemplate: (template: GoalTemplate) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("goals.templatesTitle")}>
      <SettingsCard testID="goal-templates">
        {GOAL_TEMPLATES.map((template) => (
          <TemplateRow key={template.id} template={template} onTemplate={onTemplate} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function TemplateRow({
  template,
  onTemplate,
}: {
  template: GoalTemplate;
  onTemplate: (template: GoalTemplate) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onTemplate(template), [onTemplate, template]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );
  return (
    <PressHighlight
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`goal-template-${template.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t(`goals.templates.${template.id}.title`)}</Text>
        <Text style={settingsStyles.rowHint}>
          {t(`goals.templates.${template.id}.description`)}
        </Text>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: {
    alignItems: "center",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    maxWidth: 440,
    marginBottom: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
