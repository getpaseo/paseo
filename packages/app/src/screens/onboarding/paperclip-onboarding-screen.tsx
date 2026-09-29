import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsInput } from "@/components/settings";
import { settingsStyles } from "@/styles/settings";
import { usePaperclipOnboarding } from "@/hooks/use-paperclip-onboarding";

export type UseCase = "personal" | "team" | "enterprise";
export type TeamShape = "solo" | "small" | "medium" | "large";

const USECASE_OPTIONS = [
  { value: "personal", label: "Personal" },
  { value: "team", label: "Team" },
  { value: "enterprise", label: "Enterprise" },
] as const;

const TEAM_SHAPE_OPTIONS = [
  { value: "solo", label: "Solo (1-2)" },
  { value: "small", label: "Small (3-10)" },
  { value: "medium", label: "Medium (11-50)" },
  { value: "large", label: "Large (50+)" },
] as const;

const styles = StyleSheet.create({
  screen: { padding: 24 },
  heading: { marginBottom: 24 },
  headingTitle: { fontSize: 24, fontWeight: "500", marginBottom: 8 },
  section: { marginVertical: 16 },
  control: { marginTop: 12 },
  action: { marginTop: 24 },
});

export function PaperclipOnboardingScreen({
  onComplete,
}: {
  onComplete?: (data: { useCase: UseCase; teamShape: TeamShape; teamName?: string }) => void;
}) {
  const { t } = useTranslation();
  const { config, completeOnboarding, isConnected, isLoading } = usePaperclipOnboarding();
  const [useCase, setUseCase] = useState<UseCase>("personal");
  const [teamShape, setTeamShape] = useState<TeamShape>("solo");
  const [teamName, setTeamName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const saved = config?.paperclip;
    if (!saved) return;
    if (saved.useCase) setUseCase(saved.useCase);
    if (saved.teamShape) setTeamShape(saved.teamShape);
    if (saved.teamName !== undefined) setTeamName(saved.teamName);
  }, [config?.paperclip]);

  const handleComplete = useCallback(async () => {
    setIsSaving(true);
    try {
      await completeOnboarding({ useCase, teamShape, teamName });
      onComplete?.({ useCase, teamShape, teamName: teamName.trim() || undefined });
    } finally {
      setIsSaving(false);
    }
  }, [completeOnboarding, onComplete, teamName, teamShape, useCase]);

  const isValid = isConnected && !isLoading && !isSaving;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, styles.heading]}>
          <Text style={[settingsStyles.rowTitle, styles.headingTitle]}>
            {t("paperclip.onboarding.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>{t("paperclip.onboarding.description")}</Text>
        </View>

        <View style={[settingsStyles.rowBorder, styles.section]}>
          <Text style={settingsStyles.rowTitle}>{t("paperclip.onboarding.useCase.label")}</Text>
          <Text style={settingsStyles.rowHint}>{t("paperclip.onboarding.useCase.hint")}</Text>
          <View style={styles.control}>
            <SegmentedControl
              value={useCase}
              options={[...USECASE_OPTIONS]}
              onValueChange={setUseCase}
            />
          </View>
        </View>

        <View style={[settingsStyles.rowBorder, styles.section]}>
          <Text style={settingsStyles.rowTitle}>{t("paperclip.onboarding.teamShape.label")}</Text>
          <Text style={settingsStyles.rowHint}>{t("paperclip.onboarding.teamShape.hint")}</Text>
          <View style={styles.control}>
            <SegmentedControl
              value={teamShape}
              options={[...TEAM_SHAPE_OPTIONS]}
              onValueChange={setTeamShape}
            />
          </View>
        </View>

        <View style={[settingsStyles.rowBorder, styles.section]}>
          <SettingsInput
            label={t("paperclip.onboarding.teamName.label")}
            hint={t("paperclip.onboarding.teamName.hint")}
            initialValue={teamName}
            placeholder={t("paperclip.onboarding.teamName.placeholder")}
            disabled={isSaving}
            onChangeText={setTeamName}
          />
        </View>

        <View style={styles.action}>
          <Button variant="default" size="md" disabled={!isValid} onPress={handleComplete}>
            {isSaving ? t("paperclip.onboarding.saving") : t("paperclip.onboarding.continue")}
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}
