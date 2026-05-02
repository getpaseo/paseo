import { describe, expect, it } from "vitest";
import { shortenPath } from "./shorten-path";

describe("shortenPath", () => {
  it("returns empty string for null", () => {
    expect(shortenPath(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(shortenPath(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(shortenPath("")).toBe("");
  });

  it("shortens macOS home directory path", () => {
    expect(shortenPath("/Users/john/Documents/project")).toBe("~/Documents/project");
  });

  it("shortens Linux home directory path", () => {
    expect(shortenPath("/home/ubuntu/projects/my-app")).toBe("~/projects/my-app");
  });

  it("replaces only the home directory prefix with tilde", () => {
    expect(shortenPath("/Users/john")).toBe("~");
  });

  it("replaces Linux home directory root with tilde", () => {
    expect(shortenPath("/home/ubuntu")).toBe("~");
  });

  it("does not modify paths outside home directory", () => {
    expect(shortenPath("/tmp/project")).toBe("/tmp/project");
  });

  it("does not modify root path", () => {
    expect(shortenPath("/")).toBe("/");
  });

  it("does not modify relative paths", () => {
    expect(shortenPath("relative/path")).toBe("relative/path");
  });

  it("handles path with trailing slash", () => {
    expect(shortenPath("/Users/john/Documents/")).toBe("~/Documents/");
  });

  it("handles usernames with special characters", () => {
    expect(shortenPath("/Users/john.doe/projects/app")).toBe("~/projects/app");
  });

  it("handles usernames with underscores", () => {
    expect(shortenPath("/Users/john_doe/projects/app")).toBe("~/projects/app");
  });

  it("does not match partial home directory name", () => {
    // /UsersX should not match
    expect(shortenPath("/UsersX/john/projects")).toBe("/UsersX/john/projects");
  });
});
