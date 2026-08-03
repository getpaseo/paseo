import { randomUUID } from "node:crypto";

// The daemon uses clientId as the reconnectable session key. Keep it stable for
// every connection attempt made by this CLI process, but never persist it across
// processes: unrelated one-shot commands must not share one server session.
const CLI_PROCESS_CLIENT_ID = `cid_${randomUUID().replace(/-/g, "")}`;

export async function getOrCreateCliClientId(): Promise<string> {
  return CLI_PROCESS_CLIENT_ID;
}
