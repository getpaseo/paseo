import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { openExternalUrl } from "@/utils/open-external-url";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CHANGELOG_URL = "https://paseo.sh/changelog";

export function UpdateBanner() {
  const { theme } = useUnistyles();
  const {
    isDesktopApp,
    status,
    availableUpdate,
    errorMessage,
    checkForUpdates,
    installUpdate,
    isInstalling,
  } = useDesktopAppUpdater();
  const [dismissed, setDismissed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isDesktopApp) return;

    void checkForUpdates({ silent: true });

    intervalRef.current = setInterval(() => {
      void checkForUpdates({ silent: true });
    }, CHECK_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isDesktopApp, checkForUpdates]);

  if (!isDesktopApp) return null;
  if (dismissed) return null;
  if (
    status !== "available" &&
    status !== "installed" &&
    status !== "installing" &&
    status !== "error"
  )
    return null;

  const isInstalled = status === "installed";
  const isError = status === "error";

  function getTitle(): string {
    if (isInstalled) return "Update installed";
    if (isInstalling) return "Installing update";
    if (isError) return "Update failed";
    return "Update available";
  }

  function getSubtitle(): string {
    if (isInstalled) return "Restart to use the new version.";
    if (isInstalling) return "Installing and restarting...";
    if (isError) return errorMessage ?? "Something went wrong.";
    return `${availableUpdate?.latestVersion ? `v${availableUpdate.latestVersion.replace(/^v/i, "")} is ready` : "A new version is ready"} to install.`;
  }

  return (
    <View style={styles.container} pointerEvents="box-none">
      <Pressable onPress={() => setDismissed(true)} hitSlop={8} style={styles.closeButton}>
        <X size={12} color={theme.colors.foregroundMuted} />
      </Pressable>

      <View style={styles.banner}>
        <View style={styles.textSection}>
          <Text style={styles.title}>{getTitle()}</Text>
          <Text style={styles.subtitle}>{getSubtitle()}</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => void openExternalUrl(CHANGELOG_URL)}
            style={({ pressed }) => [styles.outlineButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.outlineButtonText}>What's new</Text>
          </Pressable>

          {!isInstalled && !isError && (
            <Pressable
              onPress={() => void installUpdate()}
              disabled={isInstalling}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.buttonPressed,
                isInstalling && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {isInstalling ? "Installing..." : "Install & restart"}
              </Text>
            </Pressable>
          )}

          {isError && (
            <Pressable
              onPress={() => void checkForUpdates()}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    bottom: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 1000,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    ...theme.shadow.md,
    maxWidth: 480,
  },
  closeButton: {
    position: "absolute",
    top: -8,
    left: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  textSection: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  outlineButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  outlineButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  primaryButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.foreground,
  },
  primaryButtonText: {
    color: theme.colors.surface0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
