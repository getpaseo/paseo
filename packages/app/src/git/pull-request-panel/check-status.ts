/**
 * Neutral check status mapping shared by the PR-pane data builder, the forge
 * native-data contributions, and the pane render. Kept forge-agnostic: a forge
 * maps its raw CI strings onto this frozen union. Forge-specific vocabularies
 * (e.g. GitLab pipeline statuses) live in the owning forge module.
 */
export type CheckStatus = "success" | "failure" | "pending" | "skipped";

export function mapCheckStatus(status: string): CheckStatus {
  if (
    status === "success" ||
    status === "failure" ||
    status === "pending" ||
    status === "skipped"
  ) {
    return status;
  }
  if (status === "cancelled") {
    return "skipped";
  }
  return "pending";
}
