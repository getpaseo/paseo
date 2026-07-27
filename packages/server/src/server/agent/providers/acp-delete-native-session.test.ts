import { describe, expect, it } from "vitest";
import {
  ACP_SESSION_DELETE_METHOD,
  hasAcpSessionDeleteCapability,
} from "./acp-delete-native-session.js";

describe("hasAcpSessionDeleteCapability", () => {
  it("is true when sessionCapabilities.delete is present", () => {
    expect(
      hasAcpSessionDeleteCapability({
        agentCapabilities: { sessionCapabilities: { delete: {} } },
      }),
    ).toBe(true);
  });

  it("is false when delete is omitted or null", () => {
    expect(
      hasAcpSessionDeleteCapability({
        agentCapabilities: { sessionCapabilities: { list: {} } },
      }),
    ).toBe(false);
    expect(
      hasAcpSessionDeleteCapability({
        agentCapabilities: { sessionCapabilities: { delete: null } },
      }),
    ).toBe(false);
    expect(hasAcpSessionDeleteCapability({})).toBe(false);
  });
});

describe("ACP_SESSION_DELETE_METHOD", () => {
  it("matches the stabilized ACP method name", () => {
    expect(ACP_SESSION_DELETE_METHOD).toBe("session/delete");
  });
});
