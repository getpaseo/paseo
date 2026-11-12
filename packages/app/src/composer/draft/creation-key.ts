import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";

/** A timeout keeps its identity; editing the draft starts a different creation intent. */
export async function keyedDraftAgentRequest(
  draftId: string,
  request: Omit<CreateAgentRequestOptions, "idempotencyKey" | "requestId" | "onEvent">,
): Promise<CreateAgentRequestOptions> {
  const intent = JSON.stringify(request, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
  const fingerprint = await digestStringAsync(CryptoDigestAlgorithm.SHA256, intent);
  return { ...request, idempotencyKey: `${draftId}:${fingerprint}` };
}
