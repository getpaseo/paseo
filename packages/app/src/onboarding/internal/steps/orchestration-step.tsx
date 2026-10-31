import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CalendarClock, GitBranch, SquareTerminal, Users } from "lucide-react-native";
import { PaseoToolsCard } from "@/screens/settings/paseo-tools-card";
import type { Theme } from "@/styles/theme";

const ThemedUsers = withUnistyles(Users);
type ThemedIcon = typeof ThemedUsers;

const CAPABILITIES: ReadonlyArray<{
  key: "agents" | "workspaces" | "schedules" | "terminals";
  icon: ThemedIcon;
}> = [
  { key: "agents", icon: ThemedUsers },
  { key: "workspaces", icon: withUnistyles(GitBranch) },
  { key: "schedules", icon: withUnistyles(CalendarClock) },
  { key: "terminals", icon: withUnistyles(SquareTerminal) },
];

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function OrchestrationStep({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container}>
      <View style={styles.capabilities}>
        {CAPABILITIES.map(({ key, icon }) => (
          <Capability
            key={key}
            icon={icon}
            title={t(`onboarding.setup.steps.orchestration.capabilities.${key}.title`)}
            description={t(`onboarding.setup.steps.orchestration.capabilities.${key}.description`)}
          />
        ))}
      </View>
      <PaseoToolsCard serverId={serverId} />
    </View>
  );
}

function Capability({
  icon: Icon,
  title,
  description,
}: {
  icon: ThemedIcon;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.capability}>
      <Icon size={16} uniProps={mutedMapping} />
      <View style={styles.capabilityText}>
        <Text style={styles.capabilityTitle}>{title}</Text>
        <Text style={styles.capabilityDescription}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[6],
  },
  capabilities: {
    gap: theme.spacing[4],
  },
  capability: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  capabilityText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  capabilityTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  capabilityDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
}));
