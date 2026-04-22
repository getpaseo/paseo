import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { BookOpen, Check, Copy, RotateCw, TriangleAlert } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { Button } from "@/components/ui/button";
import { Fonts } from "@/constants/theme";
import { getDesktopDaemonLogs, type DesktopDaemonLogs } from "@/desktop/daemon/desktop-daemon";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { isWeb } from "@/constants/platform";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";

type StartupSplashScreenProps = {
  bootstrapState?: {
    phase: "starting-daemon" | "connecting" | "online" | "error";
    error: string | null;
    retry: () => void;
  };
};

const GITHUB_ISSUE_URL = "https://github.com/getpaseo/paseo/issues/new";
const DOCS_URL = "https://paseo.sh/docs";

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[8],
    paddingVertical: theme.spacing[8],
  },
  containerError: {
    justifyContent: "flex-start",
    paddingTop: theme.spacing[16],
  },
  errorScreen: {
    position: "relative",
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  errorScrollView: {
    flex: 1,
    ...(isWeb
      ? {
          overflowX: "auto",
          overflowY: "auto",
          WebkitAppRegion: "no-drag",
        }
      : null),
  },
  errorScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: theme.spacing[8],
    paddingVertical: theme.spacing[8],
    paddingTop: theme.spacing[16],
  },
  centeredContent: {
    alignItems: "center",
    justifyContent: "center",
    maxWidth: 520,
    width: "100%",
  },
  errorContent: {
    alignItems: "stretch",
    maxWidth: 720,
    width: "100%",
    gap: theme.spacing[6],
  },
  errorHeader: {
    alignItems: "flex-start",
  },
  title: {
    marginTop: theme.spacing[8],
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  titleError: {
    textAlign: "left",
  },
  subtitleRow: {
    marginTop: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  progressSteps: {
    marginTop: theme.spacing[4],
    gap: theme.spacing[3],
    width: "100%",
  },
  progressStepRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  subtitle: {
    marginTop: theme.spacing[8],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  subtitleInline: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  errorDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  errorMessage: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    fontFamily: Fonts.mono,
  },
  logsMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  logsContainer: {
    height: 200,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  logsScroll: {
    flexGrow: 0,
  },
  logsContent: {
    padding: theme.spacing[4],
  },
  logsText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
    ...(isWeb
      ? {
          whiteSpace: "pre",
          overflowWrap: "normal",
        }
      : null),
  },
  actionRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
}));

export function StartupSplashScreen({ bootstrapState }: StartupSplashScreenProps) {
  const { theme } = useUnistyles();
  const webScrollbarStyle = useWebScrollbarStyle();
  const [daemonLogs, setDaemonLogs] = useState<DesktopDaemonLogs | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

  const phase = bootstrapState?.phase;
  const isError = phase === "error";
  const isSimpleSplash = bootstrapState === undefined;

  useEffect(() => {
    if (!isError) {
      setDaemonLogs(null);
      setLogsError(null);
      setIsLoadingLogs(false);
      return;
    }

    let isCancelled = false;
    setIsLoadingLogs(true);
    setLogsError(null);

    void getDesktopDaemonLogs()
      .then((logs) => {
        if (isCancelled) {
          return;
        }
        setDaemonLogs(logs);
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setDaemonLogs(null);
        setLogsError(`Unable to load daemon logs: ${message}`);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingLogs(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isError]);

  const progressSteps =
    phase === "starting-daemon"
      ? [{ key: "starting-daemon", label: "Starting local server...", status: "active" as const }]
      : phase === "connecting"
        ? [
            { key: "starting-daemon", label: "Started local server", status: "complete" as const },
            {
              key: "connecting",
              label: "Connecting to local server...",
              status: "active" as const,
            },
          ]
        : [
            { key: "starting-daemon", label: "Started local server", status: "complete" as const },
            { key: "connecting", label: "Connected to local server", status: "complete" as const },
          ];

  const logsText = useMemo(() => {
    if (isLoadingLogs) {
      return "Loading daemon logs...";
    }
    if (daemonLogs?.contents) {
      return daemonLogs.contents;
    }
    if (logsError) {
      return logsError;
    }
    return "No daemon logs available.";
  }, [daemonLogs?.contents, isLoadingLogs, logsError]);

  const handleCopyLogs = () => {
    const payload = daemonLogs?.logPath
      ? `${daemonLogs.logPath}\n\n${daemonLogs.contents}`
      : logsText;
    void Clipboard.setStringAsync(payload);
  };

  if (isSimpleSplash) {
    return (
      <View style={styles.container}>
        <TitlebarDragRegion />
        <PaseoLogo size={96} />
        <Text style={styles.subtitle}>Starting up…</Text>
      </View>
    );
  }

  if (!isError) {
    return (
      <View style={styles.container}>
        <TitlebarDragRegion />
        <View style={styles.centeredContent}>
          <PaseoLogo size={96} />
          <Text style={styles.title}>Welcome to Paseo</Text>
          <View style={styles.progressSteps}>
            {progressSteps.map((step) => (
              <View key={step.key} style={styles.progressStepRow}>
                {step.status === "complete" ? (
                  <Check size={18} color={theme.colors.success} />
                ) : (
                  <ActivityIndicator color={theme.colors.accent} />
                )}
                <Text style={styles.subtitleInline}>{step.label}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.errorScreen}>
      <TitlebarDragRegion />
      <ScrollView
        style={[styles.errorScrollView, webScrollbarStyle]}
        contentContainerStyle={styles.errorScrollContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.errorContent}>
          <View style={styles.errorHeader}>
            <PaseoLogo size={64} />
            <Text style={[styles.title, styles.titleError]}>Something went wrong</Text>
          </View>

          <Text style={styles.errorDescription}>
            The local server failed to start. If this keeps happening, please report the issue on
            GitHub and include the logs below.
          </Text>

          <Text style={styles.errorMessage}>{bootstrapState.error}</Text>

          {daemonLogs?.logPath ? <Text style={styles.logsMeta}>{daemonLogs.logPath}</Text> : null}

          <View style={styles.logsContainer}>
            <ScrollView
              style={[styles.logsScroll, webScrollbarStyle]}
              contentContainerStyle={styles.logsContent}
              showsVerticalScrollIndicator
            >
              <Text selectable style={styles.logsText}>
                {logsText}
              </Text>
            </ScrollView>
          </View>

          <View style={styles.actionRow}>
            <Button
              variant="secondary"
              leftIcon={<Copy size={16} color={theme.colors.foreground} />}
              onPress={handleCopyLogs}
            >
              Copy logs
            </Button>
            <Button
              variant="outline"
              leftIcon={<TriangleAlert size={16} color={theme.colors.foreground} />}
              onPress={() => void openExternalUrl(GITHUB_ISSUE_URL)}
            >
              Open GitHub issue
            </Button>
            <Button
              variant="outline"
              leftIcon={<BookOpen size={16} color={theme.colors.foreground} />}
              onPress={() => void openExternalUrl(DOCS_URL)}
            >
              Docs
            </Button>
            <Button
              variant="default"
              leftIcon={<RotateCw size={16} color={theme.colors.palette.white} />}
              onPress={bootstrapState.retry}
            >
              Retry
            </Button>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
