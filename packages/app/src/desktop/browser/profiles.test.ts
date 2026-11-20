import { expect, test } from "vitest";
import { profilePartition, workspaceProfile, sharedDefault } from "./profiles";

test("uses stable, server-qualified scope keys and the existing shared default", async () => {
  const first = await workspaceProfile("server", "project", "one", "Main");
  const second = await workspaceProfile("server", "project", "two", "Main");
  const scope = "persist:paseo-project-17000d962c582024d649a8dc9250b87d-";
  expect(await profilePartition(first)).toBe(scope + "ws-7182ede8064e038c131de82e079c51a0");
  expect(await profilePartition(second)).toBe(scope + "ws-163672f41dcff03f8f60d0ca8f4ffd0c");
  expect(await profilePartition({ ...first, name: "Renamed" })).toBe(await profilePartition(first));
  expect(
    await profilePartition(await workspaceProfile("other", "project", "one", "Main")),
  ).not.toBe(await profilePartition(first));
  expect(await profilePartition({ ...first, slug: "work" })).toBe(scope + "work");
  expect(await profilePartition({ group: null, name: "Work", slug: "work" })).toBe(
    "persist:paseo-shared-work",
  );
  expect(await profilePartition(sharedDefault)).toBe("persist:paseo-browser");
});
