import { describe, expect, it } from "vitest";
import { createBrowserRecord } from "@/desktop/browser/store/state";
import { browsersOfArchivedAgents } from "./owner-cleanup";

const record = (browserId: string, ownerAgentId: string | null) => ({
  ...createBrowserRecord({ browserId, initialUrl: "https://example.com", now: 1 }),
  ownerAgentId,
});

describe("browsersOfArchivedAgents", () => {
  it("closes only browsers whose owner is archived", () => {
    const browsersById = {
      a: record("a", "dev"),
      b: record("b", "review"),
      c: record("c", null),
      d: record("d", "unknown"),
    };
    const agents = new Map([
      ["dev", { archivedAt: new Date() }],
      ["review", { archivedAt: null }],
    ]);
    expect(browsersOfArchivedAgents(browsersById, agents)).toEqual(["a"]);
  });
});
