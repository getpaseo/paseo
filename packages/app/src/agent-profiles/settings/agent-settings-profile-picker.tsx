import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react-native";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";

export function AgentSettingsProfilePicker({
  serverId,
  value,
  onSelect,
  disabled,
}: {
  serverId: string | null;
  value?: string;
  onSelect?: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "agentSettingsProfiles");
  const { config } = useDaemonConfig(serverId);
  const bundle = config?.agentSettingsProfiles;
  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      bundle?.profiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
        disabled,
        testID: `chat-settings-profile-${profile.id}`,
      })) ?? [],
    [bundle, disabled],
  );
  const title = t("settings.host.agentSettingsProfiles.title");
  if (!supported || !bundle || !onSelect) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.profiles}
      accessibilityLabel={title}
      testID="chat-settings-profile-selector"
    >
      <SegmentedControl
        options={options}
        value={value ?? bundle.activeProfileId}
        onValueChange={onSelect}
        size="sm"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  profiles: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
}));

export function AgentSettingsProfileLabel({ name }: { name?: string }) {
  const { t } = useTranslation();
  return name ? (
    <View
      style={labelStyles.container}
      testID="chat-settings-profile-label"
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${t("settings.host.agentSettingsProfiles.title")}: ${name}`}
    >
      <ComposerToolbarGlyph size={16}>
        <Settings2 size={16} color={labelStyles.iconColor.color} />
      </ComposerToolbarGlyph>
      <Text style={labelStyles.text} numberOfLines={1} testID="chat-settings-profile-name">
        {name}
      </Text>
    </View>
  ) : null;
}

const labelStyles = StyleSheet.create((theme) => ({
  container: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginVertical: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  text: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  iconColor: { color: theme.colors.foregroundMuted },
}));
