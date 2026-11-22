import { expect, test } from "vitest";
import {
  automaticProfileLabel,
  profilePartition,
  workspaceProfile,
  sharedDefault,
} from "./profiles";

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

test("distinguishes a previously saved or renamed workspace collision without changing either identity", async () => {
  const automatic = await workspaceProfile("server", "project", "id", "Main");
  const catalog = [
    { ...automatic, slug: "main", name: "MAIN" },
    { ...automatic, slug: "main-workspace", name: "Main (Workspace)" },
  ];
  expect(automaticProfileLabel(automatic, catalog, "Workspace")).toBe("Main (Workspace 2)");
  expect(automaticProfileLabel(automatic, [{ ...catalog[0], group: null }], "Workspace")).toBe(
    "Main",
  );
  expect(await profilePartition(automatic)).not.toBe(await profilePartition(catalog[0]));
});

test("qualifies the automatic label against a canonically equivalent named profile", async () => {
  for (const [workspace, named] of [
    ["Caf\u00e9 1", "Cafe\u0301 1"],
    ["Cafe\u0301 1", "Caf\u00e9 1"],
  ]) {
    const automatic = await workspaceProfile("server", "project", "id", workspace);
    const entry = { ...automatic, slug: "cafe-1", name: named };
    const label = automaticProfileLabel(automatic, [entry], "Workspace");
    expect(label).toBe(workspace + " (Workspace)");
    expect(label.normalize("NFC")).not.toBe(named.normalize("NFC"));
    expect(await profilePartition(automatic)).not.toBe(await profilePartition(entry));
  }
  const automatic = await workspaceProfile("server", "project", "id", "Café");
  const plain = { ...automatic, slug: "cafe", name: "Cafe" };
  expect(automaticProfileLabel(automatic, [plain], "Workspace")).toBe("Café");
});
