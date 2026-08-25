import { describe, expect, it } from "vitest";
import { verifyCodexAccountReadResponse } from "./codex-account-read.js";

describe("verifyCodexAccountReadResponse", () => {
  it("verifies the ChatGPT account reported by the app-server", () => {
    expect(
      verifyCodexAccountReadResponse(
        {
          account: { type: "chatgpt", email: "new@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
        "new@example.com",
      ),
    ).toEqual({
      status: "verified",
      accountType: "chatgpt",
      label: "new@example.com",
      expectedFingerprint: "f00305010233",
      actualFingerprint: "f00305010233",
    });
  });

  it("reports a different account returned by the app-server", () => {
    const result = verifyCodexAccountReadResponse(
      {
        account: { type: "chatgpt", email: "old@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
      "new@example.com",
    );

    expect(result.status).toBe("mismatch");
    expect(result.label).toBe("old@example.com");
    expect(result.expectedFingerprint).not.toBe(result.actualFingerprint);
  });

  it("does not claim a specific API credential was verified", () => {
    expect(
      verifyCodexAccountReadResponse(
        {
          account: { type: "apiKey" },
          requiresOpenaiAuth: true,
        },
        "API credential",
      ),
    ).toEqual({
      status: "unavailable",
      accountType: "apiKey",
      label: "API credential",
      expectedFingerprint: null,
      actualFingerprint: null,
    });
  });

  it("verifies that the new app-server is signed out", () => {
    expect(
      verifyCodexAccountReadResponse({ account: null, requiresOpenaiAuth: true }, "Not signed in"),
    ).toEqual({
      status: "verified",
      accountType: "signedOut",
      label: "Not signed in",
      expectedFingerprint: null,
      actualFingerprint: null,
    });
  });
});
