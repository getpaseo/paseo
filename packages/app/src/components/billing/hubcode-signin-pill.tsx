// Drop-in replacement for the model picker when an agent is locked
// into the Hubcode provider but the user has no auth-server session
// (or the fetch for combos failed with 401). The agent's provider
// can't be changed at runtime — the daemon binds it at creation
// time — so the most useful action is to send the user to sign in;
// once the cookie is back, `useHubcodeModels` re-fetches and the
// status bar swaps the pill back out for the real picker.

import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { LogIn, Sparkles } from "lucide-react-native";
import { authServerBaseUrl } from "@/desktop/auth/web-auth-api";
import { openExternalUrl } from "@/utils/open-external-url";

interface Props {
  /** Tightens the pill so it can sit next to other compact controls. */
  compact?: boolean;
}

export function HubcodeSignInPill({ compact }: Props) {
  const { theme } = useUnistyles();

  const handlePress = () => {
    void openExternalUrl(`${authServerBaseUrl()}/sign-in/web`).catch(() => {});
  };

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed, hovered }) => [
        styles.root,
        hovered && styles.rootHovered,
        pressed && styles.rootPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel="Sign in to Hubcode"
      testID="hubcode-signin-pill"
    >
      <Sparkles size={13} color={theme.colors.brandMagenta} />
      {!compact ? (
        <Text style={styles.text}>Sign in to Hubcode</Text>
      ) : (
        <Text style={styles.text}>Sign in</Text>
      )}
      <View style={styles.cta}>
        <LogIn size={11} color="#fff" />
        <Text style={styles.ctaText}>Open</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing[2],
    paddingVertical: 6,
    paddingHorizontal: theme.spacing[3],
    borderRadius: 999,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.brandMagenta,
  },
  rootHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rootPressed: {
    opacity: 0.85,
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  cta: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    backgroundColor: theme.colors.brandMagenta,
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: 999,
  },
  ctaText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.bold,
    color: "#fff",
  },
}));
