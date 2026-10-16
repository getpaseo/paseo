import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Heart } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons/github-icon";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { openWebUrl as openExternalUrl, type WebUrlClick } from "@/utils/open-web-url";

const renderGitHubIcon = (color: string) => <GitHubIcon color={color} size={14} />;
const renderDiscordIcon = (color: string) => <DiscordIcon color={color} size={14} />;

export function CommunityLinks() {
  const handleOpenGitHub = useCallback((event?: WebUrlClick) => {
    void openExternalUrl("https://github.com/getpaseo/paseo", event);
  }, []);

  const handleOpenSponsor = useCallback((event?: WebUrlClick) => {
    void openExternalUrl("https://github.com/sponsors/boudra", event);
  }, []);

  const handleOpenDiscord = useCallback((event?: WebUrlClick) => {
    void openExternalUrl("https://discord.gg/jz8T2uahpH", event);
  }, []);

  return (
    <View style={styles.row}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={renderGitHubIcon}
        onPress={handleOpenGitHub}
        testID="community-links-github-star"
      >
        Star
      </Button>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Heart}
        onPress={handleOpenSponsor}
        testID="community-links-sponsor"
      >
        Sponsor
      </Button>
      <Button
        variant="ghost"
        size="sm"
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
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
  },
}));
