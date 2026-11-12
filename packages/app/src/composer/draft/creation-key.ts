import { hash } from "fast-sha256";
import { Buffer } from "buffer";
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
  // WebCrypto hashing requires HTTPS; the bundled UI also runs on LAN HTTP origins.
  const fingerprint = Buffer.from(hash(Buffer.from(intent, "utf8"))).toString("hex");
  return { ...request, idempotencyKey: `${draftId}:${fingerprint}` };
}
