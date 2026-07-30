import { expect, test } from "vitest";
import { resolveProjectSettingsHostTarget } from "./project-settings-host-selection";

test("falls back when the selected host is no longer editable", () => {
  const hostA = { serverId: "host-a", projectId: "project-a" };
  const hostB = { serverId: "host-b", projectId: "project-b" };

  expect(
    resolveProjectSettingsHostTarget({
      routeKey: "host-a:project-a",
      editableHosts: [hostA],
      defaultHost: hostA,
      selection: { routeKey: "host-a:project-a", ...hostB },
    }),
  ).toEqual(hostA);
});

test("keeps the selected host while it remains editable", () => {
  const hostA = { serverId: "host-a", projectId: "project-a" };
  const hostB = { serverId: "host-b", projectId: "project-b" };

  expect(
    resolveProjectSettingsHostTarget({
      routeKey: "host-a:project-a",
      editableHosts: [hostA, hostB],
      defaultHost: hostA,
      selection: { routeKey: "host-a:project-a", ...hostB },
    }),
  ).toEqual(hostB);
});
