import {
  DaemonConnectionTestError,
  getConnectionAuthFailureReason,
} from "@/utils/test-daemon-connection";

interface ConnectionFailureLabels {
  failedToConnect: (endpoint: string) => string;
  noAdditionalDetails: (detail: string) => string;
  timedOut: string;
  refused: string;
  hostNotFound: string;
  hostUnreachable: string;
  tlsError: string;
  unableToConnect: string;
}

function normalizeTransportMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed;
}

function formatTechnicalTransportDetails(
  details: (string | null)[],
  labels: ConnectionFailureLabels,
): string | null {
  const unique = Array.from(
    new Set(
      details
        .map((value) => normalizeTransportMessage(value))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (unique.length === 0) return null;

  const allGeneric = unique.every((value) => {
    const lower = value.toLowerCase();
    return lower === "transport error" || lower === "transport closed";
  });

  if (allGeneric) {
    return labels.noAdditionalDetails(unique[0] ?? "");
  }

  return unique.join(" — ");
}

export function buildConnectionFailureCopy(input: {
  endpoint: string;
  error: unknown;
  labels: ConnectionFailureLabels;
}): { title: string; detail: string | null; raw: string | null } {
  const { endpoint, error, labels } = input;
  const title = labels.failedToConnect(endpoint);

  const raw = (() => {
    if (error instanceof DaemonConnectionTestError) {
      return (
        formatTechnicalTransportDetails([error.reason, error.lastError], labels) ??
        normalizeTransportMessage(error.message)
      );
    }
    if (error instanceof Error) {
      return normalizeTransportMessage(error.message);
    }
    return null;
  })();

  const rawLower = raw?.toLowerCase() ?? "";
  let detail: string | null = null;

  if (getConnectionAuthFailureReason(error)) {
    detail = error instanceof Error ? error.message : raw;
  } else if (rawLower.includes("timed out")) {
    detail = labels.timedOut;
  } else if (
    rawLower.includes("econnrefused") ||
    rawLower.includes("connection refused") ||
    rawLower.includes("err_connection_refused")
  ) {
    detail = labels.refused;
  } else if (rawLower.includes("unable to resolve host") || rawLower.includes("enotfound")) {
    detail = labels.hostNotFound;
  } else if (
    rawLower.includes("certificate") ||
    rawLower.includes("certpathvalidator") ||
    rawLower.includes("trust anchor") ||
    rawLower.includes("tls") ||
    rawLower.includes("ssl")
  ) {
    detail = labels.tlsError;
  } else if (rawLower.includes("not found")) {
    detail = labels.hostNotFound;
  } else if (rawLower.includes("ehostunreach") || rawLower.includes("host is unreachable")) {
    detail = labels.hostUnreachable;
  } else {
    detail = labels.unableToConnect;
  }

  return { title, detail, raw };
}
