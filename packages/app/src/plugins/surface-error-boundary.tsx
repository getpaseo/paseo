import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  INITIAL_SURFACE_RETRY_STATE,
  reduceSurfaceRetry,
  type SurfaceRetryOutcome,
  type SurfaceRetryState,
} from "./surface-retry-policy";

interface SurfaceErrorBoundaryProps {
  children: ReactNode;
  installation: object;
  /** A change re-arms the retry: the identity of the surface the user is looking at changed. */
  resetKey?: unknown;
  Surface: unknown;
  /**
   * Retry a failed render once after this delay. Zero or absent leaves the failure on screen.
   * `PluginSurfaceScreen` passes the delay; panels and buttons do not.
   */
  retryDelayMs?: number;
  renderError?(error: string): ReactNode;
}

export class SurfaceErrorBoundary extends Component<SurfaceErrorBoundaryProps, SurfaceRetryState> {
  state: SurfaceRetryState = INITIAL_SURFACE_RETRY_STATE;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<SurfaceRetryState> {
    // Partial: `retryUsed` has to survive the failure it was set for, or the retry would repeat.
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[Plugins] Surface render failed", error, info.componentStack);
    this.apply(
      reduceSurfaceRetry(
        this.state,
        { type: "failed", message: error instanceof Error ? error.message : String(error) },
        { retryDelayMs: this.props.retryDelayMs ?? 0 },
      ),
    );
  }

  componentDidUpdate(previousProps: SurfaceErrorBoundaryProps): void {
    const identityChanged =
      previousProps.installation !== this.props.installation ||
      previousProps.resetKey !== this.props.resetKey ||
      previousProps.Surface !== this.props.Surface;
    if (!identityChanged) return;
    this.apply(
      reduceSurfaceRetry(
        this.state,
        { type: "identity-changed" },
        {
          retryDelayMs: this.props.retryDelayMs ?? 0,
        },
      ),
    );
  }

  componentWillUnmount(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private apply(outcome: SurfaceRetryOutcome): void {
    if (outcome.cancelRetry && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const next = outcome.state;
    if (
      next.error !== this.state.error ||
      next.retryUsed !== this.state.retryUsed ||
      next.retryPending !== this.state.retryPending
    ) {
      this.setState(next);
    }
    if (!outcome.scheduleRetry) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState(
        reduceSurfaceRetry(
          this.state,
          { type: "retry-elapsed" },
          { retryDelayMs: this.props.retryDelayMs ?? 0 },
        ).state,
      );
    }, this.props.retryDelayMs ?? 0);
  }

  render() {
    if (this.state.retryPending) return null;
    if (this.state.error) {
      if (this.props.renderError) return this.props.renderError(this.state.error);
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
