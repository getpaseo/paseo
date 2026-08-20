import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface SurfaceErrorBoundaryProps {
  children: ReactNode;
  installation: object;
  Surface: unknown;
}

interface SurfaceErrorBoundaryState {
  error: string | null;
}

export class SurfaceErrorBoundary extends Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  state: SurfaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SurfaceErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[Plugins] Surface render failed", error, info.componentStack);
  }

  componentDidUpdate(previous: SurfaceErrorBoundaryProps): void {
    if (
      this.state.error &&
      (previous.installation !== this.props.installation || previous.Surface !== this.props.Surface)
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return <Text style={styles.errorText}>Plugin failed: {this.state.error}</Text>;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create((theme) => ({
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
