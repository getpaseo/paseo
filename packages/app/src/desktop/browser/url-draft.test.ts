import { describe, expect, it } from "vitest";
import { resolveBrowserUrlDraft } from "./url-draft";

describe("resolveBrowserUrlDraft", () => {
  it("gives a scheme-less draft a scheme so the daemon accepts it", () => {
    expect(resolveBrowserUrlDraft("  google.com  ")).toEqual({
      status: "navigate",
      url: "https://google.com",
    });
  });

  it("navigates a localhost draft over http", () => {
    expect(resolveBrowserUrlDraft("localhost:8081")).toEqual({
      status: "navigate",
      url: "http://localhost:8081",
    });
  });

  it("keeps a draft that already names its scheme", () => {
    expect(resolveBrowserUrlDraft("https://a.test/path?q=1")).toEqual({
      status: "navigate",
      url: "https://a.test/path?q=1",
    });
  });

  it("ignores a blank draft", () => {
    expect(resolveBrowserUrlDraft("   ")).toEqual({ status: "ignored" });
  });

  it("ignores a draft the url bar could not produce", () => {
    expect(resolveBrowserUrlDraft(undefined)).toEqual({ status: "ignored" });
  });
});
