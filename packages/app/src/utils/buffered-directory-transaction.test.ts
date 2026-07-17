import { describe, expect, it } from "vitest";
import { inheritBufferedDirectoryDeltas } from "./buffered-directory-transaction";

describe("inheritBufferedDirectoryDeltas", () => {
  it("hands buffered updates to a superseding transaction for the same client", () => {
    const client = {};
    const previous = { client, deltas: ["first"] };

    const inherited = inheritBufferedDirectoryDeltas({ client, previous });
    previous.deltas.push("later");

    expect(inherited).toEqual(["first"]);
  });

  it("does not carry updates across clients", () => {
    expect(
      inheritBufferedDirectoryDeltas({
        client: {},
        previous: { client: {}, deltas: ["stale"] },
      }),
    ).toEqual([]);
  });
});
