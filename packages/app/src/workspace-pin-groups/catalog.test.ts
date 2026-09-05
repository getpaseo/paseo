import { describe, expect, it } from "vitest";
import type { WorkspacePinGroup } from "@getpaseo/protocol/messages";
import { selectCurrentWorkspacePinGroupCatalog } from "./catalog";

const hostACatalog: readonly WorkspacePinGroup[] = [
  { id: "default", name: "Pinned", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: "host-a-group", name: "Host A", createdAt: "2026-09-01T00:01:00.000Z" },
];

describe("selectCurrentWorkspacePinGroupCatalog", () => {
  it("suppresses a previous host's placeholder catalog", () => {
    expect(
      selectCurrentWorkspacePinGroupCatalog({
        data: hostACatalog,
        isPlaceholderData: true,
      }),
    ).toBeUndefined();
  });

  it("returns catalog data after the current host query resolves", () => {
    expect(
      selectCurrentWorkspacePinGroupCatalog({
        data: hostACatalog,
        isPlaceholderData: false,
      }),
    ).toBe(hostACatalog);
  });
});
