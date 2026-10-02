import { expect, it } from "vitest";
import { formatRoutingNotice } from "./routing-notice";
import type { AgentRoutingNotice } from "@getpaseo/protocol/messages";

const notice: AgentRoutingNotice = {
  fromProfile: "codex-plus",
  toProfile: "codex-business",
  fromModel: "gpt-6.1-sol",
  model: "gpt-6.1-sol",
  fromEffort: "medium",
  effort: "medium",
  resetsAt: "2026-09-30T14:00:00Z",
  status: "selected",
  reason: "Jev preserved model and effort",
};
it("formats structured profile/model/effort and the local reset without parsing timeline prose", () => {
  const result = formatRoutingNotice(notice, "de-DE");
  expect(result).toContain(
    "codex-plus · gpt-6.1-sol · medium → codex-business · gpt-6.1-sol · medium",
  );
  expect(result).toContain(
    new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(
      Date.parse(notice.resetsAt!),
    ),
  );
  expect(result).toContain(notice.reason);
});
it("makes recovery, waiting and missing reset evidence explicit", () => {
  expect(formatRoutingNotice({ ...notice, status: "retrying" })).toContain("Recovering:");
  expect(formatRoutingNotice({ ...notice, status: "waiting", resetsAt: null })).toContain(
    "availability unconfirmed",
  );
  expect(formatRoutingNotice({ ...notice, resetsAt: "invalid" })).toContain("reset unavailable");
});
