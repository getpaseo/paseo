import { describe, expect, test } from "vitest";
import { resolveProjectKey } from "./project-key";

describe("resolveProjectKey", () => {
  test("keeps legacy path-shaped project IDs local to their host", () => {
    const resolve = (serverId: string) =>
      resolveProjectKey({ serverId, projectId: "/workspace/app" });

    expect(resolve("host-a")).not.toBe(resolve("host-b"));
  });

  test("keeps recognized legacy remote project IDs shared across hosts", () => {
    const resolve = (serverId: string) =>
      resolveProjectKey({ serverId, projectId: "remote:github.com/acme/app" });

    expect(resolve("host-a")).toBe(resolve("host-b"));
  });
});
