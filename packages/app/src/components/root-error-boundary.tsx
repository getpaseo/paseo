import React, { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PressableStateCallbackType, StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

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
    if (error) {
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
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      testID="root-error-boundary"
    >
      <View style={styles.content}>
        <Text style={styles.kicker}>Something went wrong</Text>
        <Text style={styles.title}>Paseo ran into a problem.</Text>
        <Text style={styles.body}>
          Try again to reload the app. If this keeps happening, include the details below when you
          report it.
        </Text>
        <View style={styles.messageBox}>
          <Text style={styles.messageLabel}>Details</Text>
          <Text style={styles.message}>{error}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={retryButtonStyle}
          testID="root-error-boundary-retry"
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function formatCaughtValue(value: unknown): string {
  if (value instanceof Error) {
    return formatError(value);
  }

  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return String(value);
  }

  return stringifyJson(value) ?? String(value);
}

function formatError(error: Error): string {
  const sections: string[] = [];
  const name = error.name.trim();
  const message = error.message.trim();
  const stack = error.stack?.trim();

  if (name) {
    sections.push(`Name: ${name}`);
  }
  if (message) {
    sections.push(`Message: ${message}`);
  }
  if (stack) {
    sections.push(`Stack:\n${stack}`);
  }

  const errorCause = getErrorCause(error);
  if (errorCause.hasCause) {
    sections.push(`Cause:\n${formatCaughtValue(errorCause.value)}`);
  }

  const aggregateErrors = getAggregateErrors(error);
  if (aggregateErrors !== null) {
    sections.push(`Errors:\n${formatCaughtValue(aggregateErrors)}`);
  }

  const fields = getErrorFields(error);
  if (fields !== null) {
    sections.push(`Fields:\n${stringifyJson(fields) ?? String(fields)}`);
  }

  return sections.join("\n\n") || String(error);
}

function getErrorCause(error: Error): { hasCause: boolean; value: unknown } {
  if (!Reflect.has(error, "cause")) {
    return { hasCause: false, value: null };
  }
  return { hasCause: true, value: Reflect.get(error, "cause") };
}

function getAggregateErrors(error: Error): unknown | null {
  if (!Reflect.has(error, "errors")) {
    return null;
  }
  return Reflect.get(error, "errors");
}

function getErrorFields(error: Error): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }
    fields[key] = Reflect.get(error, key);
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

function stringifyJson(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (typeof nestedValue === "bigint") {
          return String(nestedValue);
        }
        if (nestedValue !== null && typeof nestedValue === "object") {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      },
      2,
    );
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
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
