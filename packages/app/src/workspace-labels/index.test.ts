import { describe, expect, test } from "vitest";
import {
  buildWorkspaceLabelPicker,
  createWorkspaceLabelManagerModel,
  createWorkspaceLabelPickerModel,
  mergeWorkspaceLabelCatalogs,
  projectWorkspaceLabels,
  selectWorkspaceLabelDefinitions,
  shouldCloseWorkspaceLabelPicker,
  type WorkspaceLabelHostSnapshot,
} from "./index";
// A label's color is no longer a table of its own: `swatch.tsx` hands every surface the
// identity color of the same name, and `identityForeground` typechecking against
// `WorkspaceLabelColor` is what keeps the protocol's ten names and the identity table's ten in
// step. There is nothing left here to assert that the compiler does not.

describe("workspace label projection", () => {
  test("merges normalized names deterministically and lets the target host definition win", () => {
    const catalogs = [
      { serverId: "host-b", labels: [{ name: "Blocked", color: "red" as const }] },
      { serverId: "host-a", labels: [{ name: "blocked", color: "sky" as const }] },
    ];
    expect(mergeWorkspaceLabelCatalogs({ catalogs })).toEqual([{ name: "blocked", color: "sky" }]);
    expect(mergeWorkspaceLabelCatalogs({ catalogs, targetServerId: "host-b" })).toEqual([
      { name: "Blocked", color: "red" },
    ]);
  });

  test("owns online filtering and target precedence in one public projection", () => {
    const projection = projectWorkspaceLabels(
      {
        online: {
          serverId: "online",
          status: "online",
          error: null,
          labels: [{ name: "Urgent", color: "red" }],
        },
        offline: {
          serverId: "offline",
          status: "offline",
          error: null,
          labels: [
            { name: "urgent", color: "sky" },
            { name: "Hidden", color: "emerald" },
          ],
        },
      },
      "offline",
    );

    expect(projection.labels).toEqual([{ name: "Urgent", color: "red" }]);
    expect(projection.targetHost?.status).toBe("offline");
  });

  test("draws a shared label name in the workspace's own host color", () => {
    // Two hosts, one name, two colors. The cross-host merge would settle this by target
    // precedence and then alphabetical serverId, so a row asking without saying whose row it is
    // can end up painted in the other host's color.
    const hostsById: Record<string, WorkspaceLabelHostSnapshot> = {
      "host-a": {
        serverId: "host-a",
        status: "online",
        error: null,
        labels: [{ name: "backend", color: "violet" }],
      },
      "host-b": {
        serverId: "host-b",
        status: "online",
        error: null,
        labels: [{ name: "Backend", color: "red" }],
      },
    };

    expect(
      selectWorkspaceLabelDefinitions({ hostsById, serverId: "host-b", names: ["Backend"] }),
    ).toEqual([{ name: "Backend", color: "red" }]);
    expect(
      selectWorkspaceLabelDefinitions({ hostsById, serverId: "host-a", names: ["backend"] }),
    ).toEqual([{ name: "backend", color: "violet" }]);
  });

  test("keeps the assignment order and drops names the workspace's own host does not know", () => {
    const hostsById: Record<string, WorkspaceLabelHostSnapshot> = {
      "host-a": {
        serverId: "host-a",
        status: "online",
        error: null,
        labels: [{ name: "Urgent", color: "red" }],
      },
      "host-b": {
        serverId: "host-b",
        status: "online",
        error: null,
        labels: [{ name: "Backend", color: "sky" }],
      },
    };

    expect(
      selectWorkspaceLabelDefinitions({
        hostsById,
        serverId: "host-a",
        names: ["urgent", "backend"],
      }),
    ).toEqual([{ name: "Urgent", color: "red" }]);
    expect(
      selectWorkspaceLabelDefinitions({ hostsById, serverId: "unknown", names: ["Urgent"] }),
    ).toEqual([]);
  });

  test("keeps create visible, prefills search, and distinguishes row from checkbox closing", () => {
    expect(
      buildWorkspaceLabelPicker({
        labels: [{ name: "Blocked", color: "red" }],
        assigned: ["blocked"],
        query: "Needs review",
      }),
    ).toEqual({
      rows: [],
      create: { name: "Needs review" },
    });
    expect(shouldCloseWorkspaceLabelPicker("row")).toBe(true);
    expect(shouldCloseWorkspaceLabelPicker("checkbox")).toBe(false);
  });

  test("picker suppresses repeated taps, keeps checkbox open, and closes row/create only on success", async () => {
    let resolveMutation!: () => void;
    let mutationCount = 0;
    let closeCount = 0;
    let fail = false;
    const model = createWorkspaceLabelPickerModel({
      mutate: async () => {
        mutationCount += 1;
        await new Promise<void>((resolve) => {
          resolveMutation = resolve;
        });
        if (fail) throw new Error("disk full");
      },
      close: () => {
        closeCount += 1;
      },
    });
    model.sync({
      labels: [{ name: "Urgent", color: "red" }],
      assigned: [],
      online: true,
    });

    const first = model.toggle({ name: "Urgent", color: "red" }, true, "checkbox");
    const repeated = model.toggle({ name: "Urgent", color: "red" }, true, "checkbox");
    expect(model.snapshot().pendingNames).toEqual(["urgent"]);
    expect(mutationCount).toBe(1);
    resolveMutation();
    await Promise.all([first, repeated]);
    expect(closeCount).toBe(0);

    model.beginCreate();
    model.setCreateName("New label");
    fail = true;
    const failedCreate = model.create("sky");
    resolveMutation();
    await failedCreate;
    expect(model.snapshot()).toMatchObject({
      creating: true,
      createName: "New label",
      error: "disk full",
    });
    expect(closeCount).toBe(0);

    fail = false;
    const row = model.toggle({ name: "Urgent", color: "red" }, true, "row");
    expect(closeCount).toBe(0);
    resolveMutation();
    await row;
    expect(closeCount).toBe(1);
  });

  test("manager owns host selection and preserves selected surfaces on mutation failure", async () => {
    let deleteCalls = 0;
    const model = createWorkspaceLabelManagerModel({
      rename: async () => {
        throw new Error("rename failed");
      },
      recolor: async () => ({ label: { name: "Urgent", color: "sky" } }),
      inspectDelete: async () => ({ affectedWorkspaceCount: 7 }),
      delete: async () => {
        deleteCalls += 1;
        throw new Error("delete failed");
      },
    });
    model.syncHosts([
      {
        serverId: "host-a",
        label: "Alpha",
        status: "online",
        labels: [{ name: "Urgent", color: "red" }],
      },
      {
        serverId: "host-b",
        label: "Beta",
        status: "online",
        labels: [{ name: "Other", color: "sky" }],
      },
    ]);
    model.selectLabel("Urgent");
    model.setDraftName("Priority");

    await model.rename();
    expect(model.snapshot()).toMatchObject({
      serverId: "host-a",
      selectedName: "Urgent",
      draftName: "Priority",
      error: "rename failed",
    });

    let confirmedCount = 0;
    const first = model.delete(async (count) => {
      confirmedCount = count;
      return true;
    });
    const repeated = model.delete(async () => true);
    await Promise.all([first, repeated]);
    expect(confirmedCount).toBe(7);
    expect(deleteCalls).toBe(1);
    expect(model.snapshot()).toMatchObject({
      selectedName: "Urgent",
      error: "delete failed",
      pending: false,
    });

    model.selectHost("host-b");
    expect(model.snapshot()).toMatchObject({ serverId: "host-b", selectedName: null });
  });

  test("manager keeps one immutable host and label target through delete confirmation", async () => {
    let confirmDelete!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      confirmDelete = resolve;
    });
    const inspected: string[] = [];
    const deleted: string[] = [];
    const model = createWorkspaceLabelManagerModel({
      rename: async () => ({}),
      recolor: async () => ({}),
      inspectDelete: async ({ serverId, name }) => {
        inspected.push(`${serverId}:${name}`);
        return { affectedWorkspaceCount: 1 };
      },
      delete: async ({ serverId, name }) => {
        deleted.push(`${serverId}:${name}`);
      },
    });
    model.syncHosts([
      {
        serverId: "host-a",
        label: "Alpha",
        status: "online",
        labels: [{ name: "Urgent", color: "red" }],
      },
      {
        serverId: "host-b",
        label: "Beta",
        status: "online",
        labels: [{ name: "Urgent", color: "sky" }],
      },
    ]);
    model.selectLabel("Urgent");

    const remove = model.delete(() => confirmation);
    await Promise.resolve();
    expect(model.snapshot().pending).toBe(true);
    model.selectHost("host-b");
    model.selectLabel("Urgent");
    confirmDelete(true);
    await remove;

    expect(inspected).toEqual(["host-a:Urgent"]);
    expect(deleted).toEqual(["host-a:Urgent"]);
    expect(model.snapshot()).toMatchObject({ serverId: "host-a", selectedName: null });
  });
});
