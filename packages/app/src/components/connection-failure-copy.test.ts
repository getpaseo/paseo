import { describe, expect, it } from "vitest";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { buildConnectionFailureCopy } from "./connection-failure-copy";

const labels = {
  hostRequired: "host required",
  invalidPort: "invalid port",
  invalidConnection: "invalid connection",
  failedToConnect: (endpoint: string) => `Failed: ${endpoint}`,
  noAdditionalDetails: (detail: string) => `No details: ${detail}`,
  timedOut: "timeout",
  refused: "refused",
  hostNotFound: "DNS failure",
  hostUnreachable: "unreachable",
  tlsError: "TLS failure",
  unableToConnect: "connection failure",
};

function failure(message: string) {
  return buildConnectionFailureCopy({
    endpoint: "tcp://example.test:443?ssl=true",
    error: new DaemonConnectionTestError(message, {
      reason: "transport error",
      lastError: message,
    }),
    labels,
  });
}

describe("direct connection failure copy", () => {
  it("identifies Android certificate validation errors without calling them DNS failures", () => {
    const message =
      "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
    expect(failure(message)).toEqual({
      title: "Failed: tcp://example.test:443?ssl=true",
      detail: labels.tlsError,
      raw: `transport error — ${message}`,
    });
  });

  it.each([
    ["certificate not found", labels.tlsError],
    ["SSL handshake failed", labels.tlsError],
    ["TLS handshake failed", labels.tlsError],
    ["getaddrinfo ENOTFOUND example.test", labels.hostNotFound],
    ["Host not found", labels.hostNotFound],
    ["connect ECONNREFUSED", labels.refused],
    ["connection timed out", labels.timedOut],
    ["EHOSTUNREACH", labels.hostUnreachable],
    ["unexpected transport failure", labels.unableToConnect],
  ])("classifies %s", (message, expected) => {
    expect(failure(message).detail).toBe(expected);
  });

  it("preserves authentication failures and their technical details", () => {
    const message = "Invalid daemon password";
    expect(
      buildConnectionFailureCopy({
        endpoint: "example.test:6767",
        error: new DaemonConnectionTestError(message, {
          reason: message,
          lastError: message,
          authFailureReason: "incorrect_password",
        }),
        labels,
      }),
    ).toMatchObject({ detail: message, raw: message });
  });
});
