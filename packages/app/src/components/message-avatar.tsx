import { memo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import type { ReactNode } from "react";

const ThemedSparkles = withUnistyles(Sparkles);

const accentColorMapping = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});

const AVATAR_SIZE = 28;
const AVATAR_GAP = 12;

interface MessageAvatarRowProps {
  children: ReactNode;
}

export const AssistantAvatarRow = memo(function AssistantAvatarRow({
  children,
}: MessageAvatarRowProps) {
  return (
    <View style={avatarStyles.row}>
      <View style={avatarStyles.avatarColumn}>
        <View style={avatarStyles.avatarCircle}>
          <ThemedSparkles size={16} uniProps={accentColorMapping} />
        </View>
      </View>
      <View style={avatarStyles.contentColumn}>{children}</View>
    </View>
  );
});

const avatarStyles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  avatarColumn: {
    width: AVATAR_SIZE,
    marginRight: AVATAR_GAP,
    alignItems: "center",
    paddingTop: theme.spacing[1],
  },
  avatarCircle: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
  },
}));
