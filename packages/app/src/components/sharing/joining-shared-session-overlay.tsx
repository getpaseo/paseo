import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Users } from "lucide-react-native";
import { useIsJoiningSharedSession } from "@/stores/shared-session-store";
import { isWeb } from "@/constants/platform";

/**
 * Full-screen overlay shown from the moment a user clicks "Join" on a shared
 * workspace until the Colyseus room is fully connected. Prevents the UI from
 * rendering workspace chrome → video panel → participant bar → sidebar in
 * visible stages. Dismisses itself as soon as the room is live.
 */
export function JoiningSharedSessionOverlay() {
  const joining = useIsJoiningSharedSession();
  const { theme } = useUnistyles();

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!joining) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: !isWeb,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: !isWeb,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [joining, pulse]);

  if (!joining) return null;

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1.8],
  });
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 0],
  });

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <View style={styles.scrim} />
      <View style={styles.card}>
        <View style={styles.iconWrap}>
          <Animated.View
            style={[
              styles.pulse,
              {
                transform: [{ scale }],
                opacity,
              },
            ]}
          />
          <View style={styles.iconCircle}>
            <Users size={26} color="#ffffff" strokeWidth={1.75} />
          </View>
        </View>
        <Text style={styles.title}>Joining session…</Text>
        <Text style={styles.subtitle}>Connecting to the room, syncing participants and video.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    ...{
      position: isWeb ? ("fixed" as "absolute") : "absolute",
    },
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10000,
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    ...(isWeb ? ({ backdropFilter: "blur(8px)" } as Record<string, unknown>) : {}),
  },
  card: {
    maxWidth: 380,
    width: "88%",
    padding: theme.spacing[6],
    borderRadius: 18,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    gap: theme.spacing[3],
    shadowColor: theme.colors.brandMagenta,
    shadowOpacity: 0.3,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 20,
  },
  iconWrap: {
    width: 72,
    height: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  pulse: {
    position: "absolute",
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.brandMagenta,
  },
  iconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.brandMagenta,
    borderWidth: 1,
    borderColor: theme.colors.brandMagenta,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.foreground,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
  },
}));
