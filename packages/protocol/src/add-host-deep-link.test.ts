import { describe, expect, it } from "vitest";
import { buildAddHostDeepLink, parseAddHostDeepLink } from "./add-host-deep-link.js";

describe("add host deep links", () => {
  it("round-trips an SSH address", () => {
    const link = buildAddHostDeepLink({ ssh: "ssh://dev@example.com:2222?daemonPort=7777" });

    expect(link).toBe(
      "paseo://hosts/add?ssh=ssh%3A%2F%2Fdev%40example.com%3A2222%3FdaemonPort%3D7777",
    );
    expect(parseAddHostDeepLink(link)).toEqual({
      ssh: "ssh://dev@example.com:2222?daemonPort=7777",
    });
    expect(parseAddHostDeepLink("paseo://hosts/add?ssh=ssh://devbox")).toEqual({
      ssh: "ssh://devbox",
    });
  });

  it("rejects links outside the exact add host route", () => {
    expect(parseAddHostDeepLink("https://hosts/add?ssh=ssh%3A%2F%2Fdevbox")).toBeNull();
    expect(parseAddHostDeepLink("paseo://hosts/add/?ssh=ssh%3A%2F%2Fdevbox")).toBeNull();
    expect(parseAddHostDeepLink("paseo://hosts/remove?ssh=ssh%3A%2F%2Fdevbox")).toBeNull();
    expect(parseAddHostDeepLink("paseo://h/add?ssh=ssh%3A%2F%2Fdevbox")).toBeNull();
    expect(parseAddHostDeepLink("paseo://hosts/add?ssh=ssh%3A%2F%2Fdevbox#x")).toBeNull();
    expect(parseAddHostDeepLink("paseo://hosts/add?ssh=ssh%3A%2F%2Fdevbox&connect=1")).toBeNull();
    expect(
      parseAddHostDeepLink("paseo://hosts/add?ssh=ssh%3A%2F%2Fa&ssh=ssh%3A%2F%2Fb"),
    ).toBeNull();
    expect(parseAddHostDeepLink("paseo://hosts/add")).toBeNull();
  });

  it("accepts only addresses the Remote SSH form accepts", () => {
    for (const ssh of [
      "",
      "devbox",
      "https://devbox",
      "ssh://user:secret@devbox",
      "ssh://-oProxyCommand=evil",
      "ssh://devbox/path",
      "ssh://devbox?identityFile=x",
    ]) {
      const link = `paseo://hosts/add?${new URLSearchParams({ ssh }).toString()}`;
      expect(parseAddHostDeepLink(link), ssh).toBeNull();
      expect(() => buildAddHostDeepLink({ ssh }), ssh).toThrow();
    }
  });
});
