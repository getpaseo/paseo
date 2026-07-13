import React, { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PressableStateCallbackType, StyleProp, ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
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

interface RootErrorFallbackProps {
  error: string;
  onRetry: () => void;
}

function RootErrorFallback({ error, onRetry }: RootErrorFallbackProps) {
  const { t } = useTranslation();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      testID="root-error-boundary"
    >
      <View style={styles.content}>
        <Text style={styles.kicker}>{t("rootError.kicker")}</Text>
        <Text style={styles.title}>{t("rootError.title")}</Text>
        <Text style={styles.body}>{t("rootError.body")}</Text>
        <View style={styles.messageBox}>
          <Text style={styles.messageLabel}>{t("rootError.details")}</Text>
          <Text style={styles.message}>{error}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={retryButtonStyle}
          testID="root-error-boundary-retry"
        >
          <Text style={styles.retryButtonText}>{t("common.actions.retry")}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function retryButtonStyle({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> {
  return [styles.retryButton, pressed ? styles.retryButtonPressed : null];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[8],
  },
  content: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 520,
    gap: theme.spacing[4],
  },
  kicker: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  body: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  messageBox: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
  },
  messageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  retryButton: {
    alignSelf: "flex-start",
    minHeight: 40,
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  retryButtonPressed: {
    opacity: 0.85,
  },
  retryButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
