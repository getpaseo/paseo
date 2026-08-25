import { createHash } from "node:crypto";
import { z } from "zod";

const CodexAccountReadResponseSchema = z
  .object({
    account: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("chatgpt"),
            email: z.string().nullable(),
          })
          .passthrough(),
        z.object({ type: z.literal("apiKey") }).passthrough(),
        z
          .object({
            type: z.literal("amazonBedrock"),
            usesCodexManagedCredentials: z.boolean().optional(),
          })
          .passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

export type CodexAccountVerificationStatus = "verified" | "mismatch" | "unavailable";

export interface CodexAccountVerification {
  status: CodexAccountVerificationStatus;
  accountType: "chatgpt" | "apiKey" | "amazonBedrock" | "signedOut";
  label: string | null;
  expectedFingerprint: string | null;
  actualFingerprint: string | null;
}

function normalizeEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized?.includes("@") ? normalized : null;
}

function fingerprint(value: string | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
}

export function verifyCodexAccountReadResponse(
  response: unknown,
  expectedLabel: string | null,
): CodexAccountVerification {
  const parsed = CodexAccountReadResponseSchema.parse(response);
  const expectedEmail = normalizeEmail(expectedLabel);
  const expectedFingerprint = fingerprint(expectedEmail);

  if (!parsed.account) {
    const expectedSignedOut = expectedLabel?.trim().toLowerCase() === "not signed in";
    let status: CodexAccountVerificationStatus = "unavailable";
    if (expectedSignedOut) {
      status = "verified";
    } else if (expectedLabel) {
      status = "mismatch";
    }
    return {
      status,
      accountType: "signedOut",
      label: "Not signed in",
      expectedFingerprint,
      actualFingerprint: null,
    };
  }

  if (parsed.account.type === "chatgpt") {
    const actualEmail = normalizeEmail(parsed.account.email);
    let status: CodexAccountVerificationStatus = "unavailable";
    if (expectedEmail && actualEmail) {
      status = expectedEmail === actualEmail ? "verified" : "mismatch";
    }
    return {
      status,
      accountType: "chatgpt",
      label: parsed.account.email?.trim() || "Codex account",
      expectedFingerprint,
      actualFingerprint: fingerprint(actualEmail),
    };
  }

  return {
    status: "unavailable",
    accountType: parsed.account.type,
    label: parsed.account.type === "apiKey" ? "API credential" : "Amazon Bedrock",
    expectedFingerprint,
    actualFingerprint: null,
  };
}
