import { describe, expect, it } from "vitest";
import { buildCompanionFeed } from "./model";
import { isCompanionEntryPending, type CompanionEntry } from "@getpaseo/protocol/companion-stream";

describe("companion feed", () => {
  it("interleaves file cards and moments by newest timestamp, with stable identities", () => {
    const entries: CompanionEntry[] = [
      {
        id: "question:one",
        kind: "question",
        text: "Ship it?",
        timestamp: "2026-09-21T12:00:00Z",
        status: "open",
        truncated: false,
      },
      {
        id: "outcome:two",
        kind: "outcome",
        text: "Done",
        timestamp: "2026-09-21T12:02:00Z",
        status: "completed",
        truncated: false,
      },
    ];
    const artifact = {
      path: "report.md",
      name: "report.md",
      kind: "markdown" as const,
      mimeType: "text/markdown",
      size: 120,
      createdAt: "2026-09-21T12:01:00Z",
      updatedAt: "2026-09-21T12:01:00Z",
    };
    const feed = buildCompanionFeed(entries, [artifact]);
    expect(feed).toEqual([
      { id: "outcome:two", kind: "entry", timestamp: entries[1].timestamp, entry: entries[1] },
      { id: "artifact:report.md", kind: "artifact", timestamp: artifact.updatedAt, artifact },
      { id: "question:one", kind: "entry", timestamp: entries[0].timestamp, entry: entries[0] },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["question:one", "outcome:two"]);
  });
  it("filters only unresolved questions and approvals", () => {
    const base = {
      id: "one",
      timestamp: "2026-09-21T12:00:00Z",
      text: "Question",
      truncated: false,
    };
    const entries: CompanionEntry[] = [
      { ...base, kind: "question", status: "open" },
      { ...base, kind: "question", status: "reply_sent" },
      { ...base, kind: "permission", requestId: "p", requestKind: "plan", status: "pending" },
      { ...base, kind: "permission", requestId: "p", requestKind: "plan", status: "expired" },
      { ...base, kind: "outcome", status: "completed" },
    ];
    expect(entries.filter(isCompanionEntryPending)).toEqual([entries[0], entries[2]]);
  });
});
