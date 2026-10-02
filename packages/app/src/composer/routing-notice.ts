import type { AgentRoutingNotice } from "@getpaseo/protocol/messages";

export function formatRoutingNotice(notice: AgentRoutingNotice, locale?: string): string {
  const from = [notice.fromProfile, notice.fromModel, notice.fromEffort]
    .filter(Boolean)
    .join(" · ");
  const to = [notice.toProfile, notice.model, notice.effort].filter(Boolean).join(" · ");
  const reset = Date.parse(notice.resetsAt ?? "");
  const timestamp = Number.isFinite(reset)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(reset)
    : null;
  if (notice.status === "unverified") return `Route unchanged: ${from}. ${notice.reason}`;
  if (notice.status === "retrying") {
    return `Recovering: ${from}${timestamp ? ` · retry at ${timestamp}` : ""}. ${notice.reason}`;
  }
  if (notice.status === "waiting" || notice.status === "exhausted") {
    return `Waiting: ${from} · ${timestamp ? `available after ${timestamp}` : "availability unconfirmed"}. ${notice.reason}`;
  }
  return `${from} → ${to} · ${timestamp ? `${notice.fromProfile} available after ${timestamp}` : "reset unavailable"}. ${notice.reason}`;
}
