import { describe, expect, test } from "vitest";
import {
  buildWorkspaceLabelPickerRows,
  createWorkspaceLabelManagerModel,
  createWorkspaceLabelPickerModel,
  mergeWorkspaceLabelCatalogs,
  projectWorkspaceLabels,
  selectWorkspaceLabelDefinitions,
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

  test("ticks a row against the assignment recorded in another case", () => {
    expect(
      buildWorkspaceLabelPickerRows({
        labels: [
          { name: "Blocked", color: "red" },
          { name: "Needs review", color: "sky" },
        ],
        assigned: ["blocked"],
      }),
    ).toEqual([
      { name: "Blocked", color: "red", assigned: true },
      { name: "Needs review", color: "sky", assigned: false },
    ]);
  });

  test("picker holds one mutation per label and keeps the failure on the page", async () => {
    let resolveMutation!: () => void;
    let mutationCount = 0;
    let fail = false;
    const model = createWorkspaceLabelPickerModel({
      mutate: async () => {
        mutationCount += 1;
        await new Promise<void>((resolve) => {
          resolveMutation = resolve;
        });
        if (fail) throw new Error("disk full");
      },
    });
    model.sync({
      labels: [{ name: "Urgent", color: "red" }],
      assigned: [],
      online: true,
    });

    // A double tap is one mutation, not an add racing a remove.
    const first = model.toggle({ name: "Urgent", color: "red" }, true);
    const repeated = model.toggle({ name: "Urgent", color: "red" }, false);
    expect(model.snapshot().pendingNames).toEqual(["urgent"]);
    expect(mutationCount).toBe(1);
    resolveMutation();
    await Promise.all([first, repeated]);
    expect(model.snapshot()).toMatchObject({ pendingNames: [], error: null });

    fail = true;
    const failed = model.toggle({ name: "Urgent", color: "red" }, true);
    resolveMutation();
    expect(await failed).toBe(false);
    expect(model.snapshot()).toMatchObject({
      error: "disk full",
      pendingNames: [],
      rows: [{ name: "Urgent", color: "red", assigned: false }],
    });
  });

  test("manager sends one update for both fields and closes the edit only once it lands", async () => {
    const updates: unknown[] = [];
    const model = createWorkspaceLabelManagerModel({
      update: async (input) => {
        updates.push(input);
        return { label: { name: "Priority", color: "sky" } };
      },
      inspectDelete: async () => ({ affectedWorkspaceCount: 0 }),
      delete: async () => undefined,
    });
    model.syncHosts([
      {
        serverId: "host-a",
        label: "Alpha",
        status: "online",
        labels: [{ name: "Urgent", color: "red" }],
      },
    ]);

    model.edit({ name: "Urgent", color: "red" });
    expect(model.snapshot()).toMatchObject({
      draft: { name: "Urgent", draftName: "Urgent", color: "red" },
      dirty: false,
    });

    model.setDraftName("Priority");
    model.setDraftColor("sky");
    expect(model.snapshot().dirty).toBe(true);

    await model.save();
    // One call carrying both fields — a rename that lands and a recolour that does not is a
    // state the user never asked for.
    expect(updates).toEqual([
      { serverId: "host-a", name: "Urgent", newName: "Priority", color: "sky" },
    ]);
    expect(model.snapshot()).toMatchObject({ draft: null, error: null });
  });

  test("manager sends only the field that changed and skips an untouched draft", async () => {
    const updates: unknown[] = [];
    const model = createWorkspaceLabelManagerModel({
      update: async (input) => {
        updates.push(input);
        return {};
      },
      inspectDelete: async () => ({ affectedWorkspaceCount: 0 }),
      delete: async () => undefined,
    });
    model.syncHosts([
      {
        serverId: "host-a",
        label: "Alpha",
        status: "online",
        labels: [{ name: "Urgent", color: "red" }],
      },
    ]);

    model.edit({ name: "Urgent", color: "red" });
    model.setDraftColor("amber");
    await model.save();
    expect(updates).toEqual([{ serverId: "host-a", name: "Urgent", color: "amber" }]);

    model.syncHosts([
      {
        serverId: "host-a",
        label: "Alpha",
        status: "online",
        labels: [{ name: "Urgent", color: "amber" }],
      },
    ]);
    model.edit({ name: "Urgent", color: "amber" });
    // Whitespace is not an edit: the name normalizes back to what the label already is.
    model.setDraftName("  Urgent ");
    expect(model.snapshot().dirty).toBe(false);
    // Nor is an empty one — Save has nothing to offer either way.
    model.setDraftName("   ");
    expect(model.snapshot().dirty).toBe(false);
    await model.save();
    expect(updates).toHaveLength(1);
  });

  test("manager owns host selection and keeps the draft intact on a failed update", async () => {
    let deleteCalls = 0;
    const model = createWorkspaceLabelManagerModel({
      update: async () => {
        // The daemon client appends the correlation it failed on to every RPC error.
        throw Object.assign(
          new Error(
            "A label with that name already exists requestType=workspace.label.update.request code=label_name_taken",
          ),
          { requestType: "workspace.label.update.request", code: "label_name_taken" },
        );
      },
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
    model.edit({ name: "Urgent", color: "red" });
    model.setDraftName("Priority");
    model.setDraftColor("amber");

    await model.save();
    // Nothing half-applied: the view stays open on the draft exactly as typed.
    expect(model.snapshot()).toMatchObject({
      serverId: "host-a",
      draft: { name: "Urgent", draftName: "Priority", color: "amber" },
      editing: { name: "Urgent", color: "red" },
      // What the daemon said, without the correlation it travelled with.
      error: "A label with that name already exists",
      pending: false,
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
      draft: { name: "Urgent" },
      error: "delete failed",
      pending: false,
    });

    model.selectHost("host-b");
    expect(model.snapshot()).toMatchObject({ serverId: "host-b", draft: null });
  });

  test("manager keeps one immutable host and label target through delete confirmation", async () => {
    let confirmDelete!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      confirmDelete = resolve;
    });
    const inspected: string[] = [];
    const deleted: string[] = [];
    const model = createWorkspaceLabelManagerModel({
      update: async () => ({}),
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
    model.edit({ name: "Urgent", color: "red" });

    const remove = model.delete(() => confirmation);
    await Promise.resolve();
    expect(model.snapshot().pending).toBe(true);
    model.selectHost("host-b");
    model.edit({ name: "Urgent", color: "sky" });
    confirmDelete(true);
    await remove;

    expect(inspected).toEqual(["host-a:Urgent"]);
    expect(deleted).toEqual(["host-a:Urgent"]);
    expect(model.snapshot()).toMatchObject({ serverId: "host-a", draft: null });
  });
});
