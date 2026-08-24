import { describe, expect, it } from "vitest";
import { createProjectIconTarget } from "./icon-target";

describe("createProjectIconTarget", () => {
  it("keeps the host effective revision in the shared cache identity", () => {
    expect(
      createProjectIconTarget({
        projectViewKey: "project-view",
        placement: {
          serverId: "host-a",
          projectId: "project-a",
          iconWorkingDir: " /work/app ",
          customIconRevision: "custom-revision",
          iconRevision: "effective-revision",
        },
      }),
    ).toEqual({
      projectViewKey: "project-view",
      serverId: "host-a",
      projectId: "project-a",
      iconWorkingDir: "/work/app",
      customIconRevision: "custom-revision",
      iconRevision: "effective-revision",
    });
  });
});
