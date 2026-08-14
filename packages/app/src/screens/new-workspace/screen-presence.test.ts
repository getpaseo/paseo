import { describe, expect, it } from "vitest";
import { isNewWorkspaceScreenActive } from "./screen-presence";

describe("isNewWorkspaceScreenActive", () => {
  it("is active while the screen is mounted and the route is /new", () => {
    expect(isNewWorkspaceScreenActive({ isMounted: true, pathname: "/new" })).toBe(true);
  });

  it("is inactive once the screen has been popped off the stack", () => {
    expect(isNewWorkspaceScreenActive({ isMounted: false, pathname: "/new" })).toBe(false);
  });

  it("is inactive while another route sits on top of the screen", () => {
    expect(isNewWorkspaceScreenActive({ isMounted: true, pathname: "/settings" })).toBe(false);
  });

  it("is inactive on a workspace route", () => {
    expect(isNewWorkspaceScreenActive({ isMounted: true, pathname: "/host/workspace/wks_1" })).toBe(
      false,
    );
  });
});
