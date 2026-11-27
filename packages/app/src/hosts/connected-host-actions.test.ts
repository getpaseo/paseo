import { describe, expect, it, vi } from "vitest";
import { approveReverseHost } from "./connected-host-actions";
import type { PaseoHostActions, HostSummary } from "@getpaseo/client";

const token = "ab".repeat(32);
const host = {
  registrationId: "hst_bakery",
  serverId: "srv_bakery",
  status: "online",
} as HostSummary;

function fixture() {
  const remove = vi.fn(async () => undefined);
  const add = vi.fn(async () => ({ registrationId: "hst_mac" }) as HostSummary);
  const dispose = vi.fn(async () => undefined);
  const list = vi.fn(async () => ({
    self: { serverId: "srv_mac", label: "Mac" },
    hosts: [host],
  }));
  const update = vi.fn(async () => host);
  const open = vi.fn(async () => ({ hosts: { add, remove }, dispose }));
  const actions = { list, update, client: open } as unknown as PaseoHostActions;
  return { actions, add, update, open, remove, dispose };
}

describe("approveReverseHost", () => {
  it("approves the pinned peer before granting it access", async () => {
    const { actions, add, update, open, dispose } = fixture();
    await approveReverseHost(actions, host, "Mac", "read", token);
    expect(open).toHaveBeenCalledWith("srv_bakery");
    expect(add).toHaveBeenCalledWith({
      connection: "reverse://srv_mac",
      incomingToken: token,
      label: "Mac",
      sourceKey: "reverse:srv_mac:hst_bakery",
    });
    expect(update).toHaveBeenCalledWith("hst_bakery", {
      reverseOffer: { token, permissions: ["daemon.read", "workspace.read"] },
    });
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it("removes an approval created by this attempt when the grant is definitively rejected", async () => {
    const { actions, update, remove, dispose } = fixture();
    update.mockRejectedValueOnce({ code: "permission_denied" });
    await expect(approveReverseHost(actions, host, "Mac", "write", token)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith("hst_mac");
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it("preserves the approval when the grant may have succeeded", async () => {
    const { actions, update, remove } = fixture();
    update.mockRejectedValueOnce({ outcome: "unknown" });
    await expect(approveReverseHost(actions, host, "Mac", "read", token)).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
