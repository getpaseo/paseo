import { observeOrderErrors, type OrderError } from "./intents";
import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { subscriptionFixture } from "@/runtime/subscription-fixture";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { sharedOrdering } from "./index";

const host = "order-host";
type Client = Pick<DaemonClient, "setOrder" | "observeOrders">;
class FakeClient implements Client {
  readonly calls: Parameters<Client["setOrder"]>[0][] = [];
  observeOrders() {
    return subscriptionFixture(
      Promise.resolve({
        requestId: "r",
        records: [
          {
            scope: { kind: "workspaces" as const, projectId: "p" },
            revision: 1,
            order: ["b", "a"],
          },
          { scope: { kind: "pinned" as const }, revision: 1, order: ["a", "b"] },
        ],
      }),
      () => () => {},
    );
  }
  async setOrder(input: Parameters<Client["setOrder"]>[0]) {
    this.calls.push(input);
    return {
      requestId: "set",
      accepted: true,
      record: { scope: input.scope, revision: input.expectedRevision + 1, order: input.order },
    };
  }
}
afterEach(() => {
  sharedOrdering.disconnect(host);
  useSessionStore.getState().clearSession(host);
  useSidebarOrderStore.setState({ workspaceOrderByProject: {}, pinnedWorkspaceOrder: [] });
});
function populate() {
  const store = useSessionStore.getState();
  store.setProjects(host, [
    normalizeProjectDescriptor({
      projectId: "p",
      projectKey: "project-key",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      projectKind: "git",
    }),
  ]);
  store.setWorkspaces(
    host,
    new Map(
      ["a", "b"].map((id) => [
        id,
        normalizeWorkspaceDescriptor({
          id,
          projectId: "p",
          projectDisplayName: "Project",
          projectRootPath: "/repo",
          workspaceDirectory: `/repo/${id}`,
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: id,
          status: "done",
          statusEnteredAt: null,
          activityAt: null,
          archivingAt: null,
          diffStat: null,
          scripts: [],
          pinnedAt: id === "a" ? "2026-01-01" : "2026-01-02",
        }),
      ]),
    ),
  );
}
test("a cold install applies shared workspace and pinned order without publishing an empty cache", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  await sharedOrdering.connect({ serverId: host, client, supported: true });
  populate();
  expect(useSidebarOrderStore.getState().getWorkspaceOrder("project-key")).toEqual([
    `${host}:b`,
    `${host}:a`,
  ]);
  expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([`${host}:a`, `${host}:b`]);
  expect(client.calls).toEqual([]);
  useSidebarOrderStore
    .getState()
    .setWorkspaceOrder("project-key", [`${host}:a`, `${host}:b`], { userInitiated: true });
  await expect
    .poll(() => client.calls)
    .toEqual([
      { scope: { kind: "workspaces", projectId: "p" }, expectedRevision: 1, order: ["a", "b"] },
    ]);
});
test("an unsupported host receives no new ordering RPC", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  populate();
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  await sharedOrdering.connect({ serverId: host, client, supported: false });
  useSidebarOrderStore
    .getState()
    .setWorkspaceOrder("project-key", [`${host}:b`, `${host}:a`], { userInitiated: true });
  expect(client.calls).toEqual([]);
  expect(errors).toEqual([{ kind: "unsupported" }]);
  release();
});
