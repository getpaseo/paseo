import * as Sentry from "@sentry/node";
import type { ErrorRequestHandler } from "express";

// tsgo doesn't see isInitialized in the @sentry/node type exports — cast through unknown
const isSentryReady = (): boolean =>
  typeof (Sentry as unknown as Record<string, unknown>).isInitialized === "function" &&
  (Sentry as unknown as { isInitialized: () => boolean }).isInitialized();

export interface SentryConfig {
  dsn: string | undefined;
  environment: string;
  release: string;
  enabled?: boolean;
}

/**
 * Initialize Sentry SDK. No-op if DSN is not configured.
 * Must be called before any other imports that need instrumentation.
 */
export function initSentry(config: SentryConfig): void {
  if (!config.dsn || config.enabled === false) {
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: 0.1,
    // Don't send PII by default
    sendDefaultPii: false,
  });
}

/**
 * Express error handler that reports to Sentry then passes to next handler.
 * Place as the LAST error handler in the middleware chain.
 */
export function sentryErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (isSentryReady()) {
      Sentry.captureException(err);
    }
    // If headers already sent, delegate to Express default handler
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  };
}

/**
 * Flush pending Sentry events before shutdown.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (isSentryReady()) {
    await Sentry.flush(timeoutMs);
  }
}
