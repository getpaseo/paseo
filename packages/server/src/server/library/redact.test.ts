import { describe, it, expect } from "vitest";
import { redactSecrets, redactAuthorizationHeader } from "./redact.js";

describe("redactSecrets", () => {
  it("masks values whose key matches a secret pattern", () => {
    const out = redactSecrets({
      API_KEY: "sk-abcdefghijklmn",
      GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxx",
      USERNAME: "alice",
      PORT: 6767,
    });
    expect(out.API_KEY).toBe("sk***mn");
    expect(out.GITHUB_TOKEN).toMatch(/^gh\*\*\*..$/);
    expect(out.USERNAME).toBe("alice");
    expect(out.PORT).toBe(6767);
  });

  it("masks even short values to ***", () => {
    expect(redactSecrets({ API_KEY: "ab" }).API_KEY).toBe("***");
    expect(redactSecrets({ API_KEY: "" }).API_KEY).toBe("***");
  });
});

describe("redactAuthorizationHeader", () => {
  it("preserves scheme, masks credential", () => {
    expect(redactAuthorizationHeader("Bearer abcdefghij")).toBe("Bearer ab***ij");
    expect(redactAuthorizationHeader("Basic dXNlcjpwYXNz")).toMatch(/^Basic /);
  });

  it("masks bare token without space", () => {
    expect(redactAuthorizationHeader("abcdefghij")).toBe("ab***ij");
  });
});
