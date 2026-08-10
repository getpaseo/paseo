import React, { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatCaughtValue } from "./root-error-details";

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: string | null;
  resetKey: number;
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
    resetKey: 0,
  };

  static getDerivedStateFromError(error: unknown): Partial<RootErrorBoundaryState> {
    return { error: formatCaughtValue(error) };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error("[RootErrorBoundary] Unhandled render error", {
      error: formatCaughtValue(error),
      componentStack: errorInfo.componentStack,
    });
  }

  retry = () => {
    this.setState(({ resetKey }) => ({
      error: null,
      resetKey: resetKey + 1,
    }));
  };

  render() {
    const { error, resetKey } = this.state;
    if (error !== null) {
      return <RootErrorFallback error={error} onRetry={this.retry} />;
    }

    return <Fragment key={resetKey}>{this.props.children}</Fragment>;
  }
}

// A stack trace is reference material, not the screen. Cap it so the message and
// the retry action stay the shape of the page; the rest scrolls.
const DETAILS_MAX_HEIGHT = 300;

interface RootErrorFallbackProps {
  error: string;
  onRetry: () => void;
}

export function RootErrorFallback({ error, onRetry }: RootErrorFallbackProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const retry = (
    <Button variant="default" onPress={onRetry} testID="root-error-boundary-retry">
      {t("common.actions.retry")}
    </Button>
  );

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
        },
      ]}
      testID="root-error-boundary"
    >
      <View style={styles.content}>
        <View style={styles.header} testID="root-error-boundary-header">
          <Text style={styles.title}>{t("rootError.title")}</Text>
          <Text style={styles.body}>{t("rootError.body")}</Text>
        </View>
        <View style={styles.details}>
          <Text style={styles.detailsLabel}>{t("rootError.details")}</Text>
          <ScrollableCodeSurface
            maxHeight={isCompact ? undefined : DETAILS_MAX_HEIGHT}
            style={styles.detailsSurface}
            scrollStyle={styles.detailsScroll}
            testID="root-error-boundary-details"
          >
            {error}
          </ScrollableCodeSurface>
        </View>
        {isCompact ? null : retry}
      </View>
      {isCompact ? <View style={styles.footer}>{retry}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flex: 1,
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    justifyContent: "center",
    gap: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[8],
  },
  header: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  body: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    textAlign: "center",
  },
  details: {
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  detailsLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  detailsSurface: {
    flexShrink: 1,
  },
  detailsScroll: {
    flexShrink: 1,
  },
  footer: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
}));
