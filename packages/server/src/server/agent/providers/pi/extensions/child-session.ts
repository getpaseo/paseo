import { CHILD_SESSION_MAX_BYTES_PER_READ, ChildSessionTail } from "./child-session-tail.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

/**
 * Reads a child session file in full.
 *
 * Replay only. The live path follows the same files through `ChildSessionFollower`, which reads
 * incrementally and is the one that can see a file that is still being appended to.
 */
export async function mapPiChildSession(
  id: string,
  file: string,
  maxBytes = CHILD_SESSION_MAX_BYTES_PER_READ,
): Promise<ProviderSubagentInputEvent[]> {
  return await new ChildSessionTail(id, file).readAll(maxBytes);
}
