import { describe, expect, it } from "vitest";
import { duplicateRemoteBrowserRecordIds } from "./remote-tab-records";

describe("duplicateRemoteBrowserRecordIds", () => {
  it("drops the record adopted from a listing when the requesting record owns the same tab", () => {
    expect(
      duplicateRemoteBrowserRecordIds([
        { browserId: "local-1", remoteBrowserId: "remote-1" },
        { browserId: "remote-1", remoteBrowserId: "remote-1" },
        { browserId: "remote-2", remoteBrowserId: "remote-2" },
        { browserId: "local-3", remoteBrowserId: null },
      ]),
    ).toEqual(["remote-1"]);
  });

  it("keeps one record when two requesting records point at the same tab", () => {
    expect(
      duplicateRemoteBrowserRecordIds([
        { browserId: "local-1", remoteBrowserId: "remote-1" },
        { browserId: "local-2", remoteBrowserId: "remote-1" },
      ]),
    ).toEqual(["local-2"]);
  });
});
