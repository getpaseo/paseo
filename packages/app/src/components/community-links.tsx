import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Heart } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons/github-icon";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { openExternalUrl } from "@/utils/open-external-url";

const renderGitHubIcon = (color: string) => <GitHubIcon color={color} size={14} />;
const renderDiscordIcon = (color: string) => <DiscordIcon color={color} size={14} />;

export function CommunityLinks() {
  const handleOpenGitHub = useCallback(() => {
    void openExternalUrl("https://github.com/getpaseo/paseo");
  }, []);

  const handleOpenSponsor = useCallback(() => {
    void openExternalUrl("https://github.com/sponsors/boudra");
  }, []);

  const handleOpenDiscord = useCallback(() => {
    void openExternalUrl("https://discord.gg/jz8T2uahpH");
  }, []);

  return (
    <View style={styles.row}>
      <Button
        variant="ghost"
        leftIcon={renderGitHubIcon}
        onPress={handleOpenGitHub}
        testID="community-links-github-star"
      >
        Star
      </Button>
      <Button
        variant="ghost"
        leftIcon={Heart}
        onPress={handleOpenSponsor}
        testID="community-links-sponsor"
      >
        Sponsor
      </Button>
      <Button
        variant="ghost"
        leftIcon={renderDiscordIcon}
        onPress={handleOpenDiscord}
        testID="community-links-discord"
      >
        Community
      </Button>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
    // Shrinks and wraps rather than running off a narrow phone screen.
    flexShrink: 1,
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
  },
}));
