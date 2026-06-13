import { describe, expect, it } from "vitest";
import { terminalActivityToStatusBucket } from "./terminal-activity-bucket";

describe("terminalActivityToStatusBucket", () => {
  it("maps working to running", () => {
    expect(terminalActivityToStatusBucket("working")).toBe("running");
  });

  it("maps idle to null", () => {
    expect(terminalActivityToStatusBucket("idle")).toBeNull();
  });

  it("maps null to null", () => {
    expect(terminalActivityToStatusBucket(null)).toBeNull();
  });

  it("maps undefined to null", () => {
    expect(terminalActivityToStatusBucket(undefined)).toBeNull();
  });
});
