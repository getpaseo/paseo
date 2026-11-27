import { describe, expect, it } from "vitest";
import { createForgePageGuard } from "./paging.js";

describe("forge toolkit page guard", () => {
  it("stops on a partial page", () => {
    const guard = createForgePageGuard({ brand: "Acme", pageSize: 10 });

    expect(guard.hasNextPage({ itemCount: 4, page: 1, visited: 4, total: undefined })).toBe(false);
  });

  it("walks until the reported total is covered", () => {
    const guard = createForgePageGuard({ brand: "Acme", pageSize: 10 });

    expect(guard.hasNextPage({ itemCount: 10, page: 1, visited: 10, total: 25 })).toBe(true);
    expect(guard.hasNextPage({ itemCount: 10, page: 3, visited: 25, total: 25 })).toBe(false);
  });

  it("throws when a full page repeats instead of advancing the cursor", () => {
    const guard = createForgePageGuard({ brand: "Acme", pageSize: 2 });

    guard.assertProgress({ itemCount: 2, pageKeys: ["1", "2"] });
    expect(() => guard.assertProgress({ itemCount: 2, pageKeys: ["1", "2"] })).toThrow(
      "Acme pagination repeated a full page without making progress",
    );
  });

  it("ignores partial pages when detecting repeats", () => {
    const guard = createForgePageGuard({ brand: "Acme", pageSize: 2 });

    guard.assertProgress({ itemCount: 1, pageKeys: ["1"] });
    expect(() => guard.assertProgress({ itemCount: 1, pageKeys: ["1"] })).not.toThrow();
  });

  it("caps an unbounded walk when the forge reports no total", () => {
    const guard = createForgePageGuard({
      brand: "Acme",
      pageSize: 2,
      maxContinuationsWithoutTotal: 3,
    });

    expect(guard.hasNextPage({ itemCount: 2, page: 3, visited: 6, total: undefined })).toBe(true);
    expect(() =>
      guard.hasNextPage({ itemCount: 2, page: 4, visited: 8, total: undefined }),
    ).toThrow("Acme pagination exceeded 3 continuations without total");
  });
});
