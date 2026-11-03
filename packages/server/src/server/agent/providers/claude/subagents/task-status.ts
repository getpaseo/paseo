import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";

/**
 * The descriptor has no paused or pending state, and neither is terminal, so both read as
 * running. `killed` is a cancellation, not a failure — the child was stopped, it did not error.
 */
export function mapTaskStatus(status: string | undefined): ProviderSubagentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return undefined;
  }
}
