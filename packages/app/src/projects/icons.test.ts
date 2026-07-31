import { describe, expect, it } from "vitest";
import { resolveProjectIconLookup } from "./icons";

describe("project icon lookup", () => {
  const target = {
    projectId: "prj_host_local",
    iconWorkingDir: "/projects/paseo",
  };

  it("uses the host-local project ID with appearance-capable daemons", () => {
    expect(resolveProjectIconLookup(target, true)).toEqual({
      kind: "project",
      projectId: "prj_host_local",
    });
  });

  it("uses the project directory with legacy daemons", () => {
    expect(resolveProjectIconLookup(target, false)).toEqual({
      kind: "legacy",
      cwd: "/projects/paseo",
    });
  });
});
