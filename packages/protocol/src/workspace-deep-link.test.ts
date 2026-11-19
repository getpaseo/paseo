import { describe, expect, it } from "vitest";
import { buildWorkspaceDeepLink, parseWorkspaceDeepLink } from "./workspace-deep-link.js";

describe("workspace deep links", () => {
  it("round-trips an exact remote workspace path", () => {
    const target = { serverId: "srv_devbox-123", path: "/home/mo/a worktree" };
    const link = buildWorkspaceDeepLink(target);

    expect(link).toBe("paseo://h/srv_devbox-123/open-project?path=%2Fhome%2Fmo%2Fa+worktree");
    expect(parseWorkspaceDeepLink(link)).toEqual(target);
  });

  it("rejects paths that require client or daemon normalization", () => {
    for (const path of ["C:\\src\\paseo", "/tmp/../repo", "/tmp//repo", "/tmp/repo "]) {
      expect(
        parseWorkspaceDeepLink(
          `paseo://h/srv_devbox/open-project?path=${encodeURIComponent(path)}`,
        ),
      ).toBeNull();
    }
    expect(parseWorkspaceDeepLink("paseo://h/srv_devbox/open-project?path=%2Ftmp%FF")).toBeNull();
  });

  it("rejects relative, oversized, and control-character paths", () => {
    expect(
      parseWorkspaceDeepLink("paseo://h/srv_devbox/open-project?path=relative%2Fworktree"),
    ).toBeNull();
    expect(
      parseWorkspaceDeepLink(`paseo://h/srv_devbox/open-project?path=%2F${"a".repeat(4096)}`),
    ).toBeNull();
    expect(
      parseWorkspaceDeepLink("paseo://h/srv_devbox/open-project?path=%2Ftmp%2Fbad%00path"),
    ).toBeNull();
  });

  it("rejects ambiguous or expanded authority", () => {
    expect(
      parseWorkspaceDeepLink("paseo://h/srv_devbox/open-project?path=%2Fone&path=%2Ftwo"),
    ).toBeNull();
    expect(
      parseWorkspaceDeepLink(
        "paseo://h/srv_devbox/open-project?path=%2Fworktree&ssh=ssh%3A%2F%2Fhost",
      ),
    ).toBeNull();
    expect(
      parseWorkspaceDeepLink("paseo://user@h/srv_devbox/open-project?path=%2Fworktree"),
    ).toBeNull();
    expect(
      parseWorkspaceDeepLink("paseo://h/not-a-server/open-project?path=%2Fworktree"),
    ).toBeNull();
  });
});
