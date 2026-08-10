import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { normalizeHubOrigin } from "./origin.js";

describe("Hub origin", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows loopback HTTP for local development: %s",
    (origin) => {
      assert.equal(normalizeHubOrigin(origin), origin);
    },
  );

  it("rejects cleartext credential transport to a remote Hub", () => {
    assert.throws(() => normalizeHubOrigin("http://hub.example.com"), {
      code: "HUB_INVALID_ORIGIN",
    });
  });
});
