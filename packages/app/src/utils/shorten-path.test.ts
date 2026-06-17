import { describe, expect, it } from "vitest";
import { shortenPath } from "./shorten-path";

describe("shortenPath", () => {
  it("shortens a macOS home directory path", () => {
    expect(shortenPath("/Users/moboudra/dev/paseo")).toBe("~/dev/paseo");
  });

  it("shortens a Linux home directory path", () => {
    expect(shortenPath("/home/moboudra/dev/paseo")).toBe("~/dev/paseo");
  });

  it("leaves non-home absolute paths unchanged", () => {
    expect(shortenPath("/var/www/app")).toBe("/var/www/app");
  });

  it("leaves Windows paths unchanged", () => {
    expect(shortenPath("C:\\Users\\moboudra\\dev\\paseo")).toBe("C:\\Users\\moboudra\\dev\\paseo");
  });

  it("returns an empty string for null or undefined", () => {
    expect(shortenPath(null)).toBe("");
    expect(shortenPath(undefined)).toBe("");
  });

  it("returns an empty string for an empty string", () => {
    expect(shortenPath("")).toBe("");
  });
});
