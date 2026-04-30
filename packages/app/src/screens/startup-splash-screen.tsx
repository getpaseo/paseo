import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { BookOpen, Check, Copy, Power, RotateCw, TriangleAlert } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HubcodeLogo } from "@/components/icons/hubcode-logo";
import { Button } from "@/components/ui/button";
import { Fonts } from "@/constants/theme";
import {
  DaemonStartError,
  getDesktopDaemonLogs,
  killProcessOnDaemonPort,
  type DesktopDaemonLogs,
} from "@/desktop/daemon/desktop-daemon";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { isWeb } from "@/constants/platform";

type StartupSplashScreenProps = {
  bootstrapState?: {
    phase: "starting-daemon" | "connecting" | "online" | "error";
    error: string | null;
    startError?: DaemonStartError | null;
    retry: () => void;
  };
};

const GITHUB_ISSUE_URL = "https://github.com/hubtool/hubcode/issues/new";
const DOCS_URL = "https://hubcode.ai/docs";

const TAGLINE = "Your dev environment. Anywhere.";

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
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Without the "Welcome" headline above, the tagline ended up flush against
  // the logo. Restore the breathing room the title used to provide.
  taglineUnderLogo: {
    marginTop: theme.spacing[8],
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
  conflictCard: {
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
  },
  conflictTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  conflictBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  conflictMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: Fonts.mono,
  },
  conflictNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    fontStyle: "italic",
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
      ? [
          {
            key: "starting-daemon",
            label: "Waking up your local agent…",
            status: "active" as const,
          },
        ]
      : phase === "connecting"
        ? [
            { key: "starting-daemon", label: "Local agent ready", status: "complete" as const },
            {
              key: "connecting",
              label: "Connecting…",
              status: "active" as const,
            },
          ]
        : [
            { key: "starting-daemon", label: "Local agent ready", status: "complete" as const },
            { key: "connecting", label: "Connected", status: "complete" as const },
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
        <HubcodeLogo size={96} />
        <Text style={styles.subtitle}>Getting things ready…</Text>
      </View>
    );
  }

  if (!isError) {
    return (
      <View style={styles.container}>
        <TitlebarDragRegion />
        <View style={styles.centeredContent}>
          {/*
            The Hubcode logo wordmark already says "hubcode", so the
            "Welcome to Hubcode" headline was duplicating it visually right
            below. Drop the title and keep only the tagline + progress.
          */}
          <HubcodeLogo size={96} />
          <Text style={[styles.tagline, styles.taglineUnderLogo]}>{TAGLINE}</Text>
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
        style={styles.errorScrollView}
        contentContainerStyle={styles.errorScrollContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.errorContent}>
          <View style={styles.errorHeader}>
            <HubcodeLogo size={64} />
            <Text style={[styles.title, styles.titleError]}>
              We couldn't start your local agent
            </Text>
          </View>

          <Text style={styles.errorDescription}>
            Your local agent didn't come online this time. Try again below — if it keeps failing,
            open a GitHub issue with the logs attached so we can dig in.
          </Text>

          <PortConflictCard
            startError={bootstrapState.startError ?? null}
            onResolved={bootstrapState.retry}
          />

          <Text style={styles.errorMessage}>{bootstrapState.error}</Text>

          {daemonLogs?.logPath ? <Text style={styles.logsMeta}>{daemonLogs.logPath}</Text> : null}

          <View style={styles.logsContainer}>
            <ScrollView
              style={styles.logsScroll}
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

function PortConflictCard({
  startError,
  onResolved,
}: {
  startError: DaemonStartError | null;
  onResolved: () => void;
}) {
  const { theme } = useUnistyles();
  const [isEnding, setIsEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  if (!startError) return null;
  if (startError.code !== "PORT_TAKEN_BY_OTHER" && startError.code !== "STALE_HUBCODE_DAEMON") {
    return null;
  }

  const port = startError.details.port ?? 6767;
  const pid = startError.details.conflictingPid ?? null;
  const processName = startError.details.conflictingProcessName ?? null;
  const isStale = startError.code === "STALE_HUBCODE_DAEMON";

  const title = isStale
    ? "Another Hubcode agent is already running"
    : `Something else is using port ${port}`;

  const body = isStale
    ? "We found a Hubcode agent from a previous session still running on your machine. It needs to be closed before this version can take over — your work is safe and won't be lost."
    : `Port ${port} is the doorway your local agent listens on, and another program is currently holding it open. End that program (or the one we detected below) and we'll start your agent on a clean slate.`;

  const buttonLabel = isStale
    ? "End the existing Hubcode agent and try again"
    : "End the conflicting process and try again";

  const handleEnd = async () => {
    if (pid === null) {
      setEndError(
        "We couldn't pinpoint the process holding the port. Please end it manually and click Retry.",
      );
      return;
    }
    setIsEnding(true);
    setEndError(null);
    try {
      const result = await killProcessOnDaemonPort(pid);
      if (!result.ok) {
        setEndError(result.error ?? "Couldn't end the process. Please try ending it manually.");
        setIsEnding(false);
        return;
      }
      onResolved();
    } catch (err) {
      setEndError(err instanceof Error ? err.message : String(err));
      setIsEnding(false);
    }
  };

  return (
    <View style={styles.conflictCard}>
      <Text style={styles.conflictTitle}>{title}</Text>
      <Text style={styles.conflictBody}>{body}</Text>
      {pid !== null ? (
        <Text style={styles.conflictMeta}>
          {processName ? `${processName} · ` : ""}
          PID {pid} · port {port}
        </Text>
      ) : (
        <Text style={styles.conflictMeta}>port {port}</Text>
      )}
      <Button
        variant="default"
        leftIcon={<Power size={16} color={theme.colors.palette.white} />}
        onPress={() => void handleEnd()}
        disabled={isEnding || pid === null}
      >
        {isEnding ? "Ending…" : buttonLabel}
      </Button>
      {endError ? <Text style={styles.errorMessage}>{endError}</Text> : null}
      {!isStale ? (
        <Text style={styles.conflictNote}>
          We won't end anything without your say-so. Hubcode only sends a polite stop signal first
          and falls back to a hard kill only if the process refuses to exit.
        </Text>
      ) : null}
    </View>
  );
}
